/**
 * src/controllers/taskController.js
 *
 * Routes:
 *   GET    /api/tasks?requirement_id=  — list tasks
 *   POST   /api/tasks                  — create a task (pm)
 *   GET    /api/tasks/:id              — get single task
 *   PATCH  /api/tasks/:id              — update task metadata (pm, member)
 *   PATCH  /api/tasks/:id/status       — change task status; triggers BFS unblocking
 *   DELETE /api/tasks/:id              — soft-delete task (pm)
 *
 *   GET    /api/tasks/dependencies?task_id=  — list deps (query param route)
 *   GET    /api/tasks/:id/dependencies       — list deps (path param route)
 *   POST   /api/tasks/dependencies           — add a dependency (DFS cycle check)
 *   DELETE /api/tasks/dependencies/:task_id/:depends_on_task_id — remove dependency
 *
 * Task status transition rules:
 *   - New tasks start as TO_DO
 *   - Tasks with unfinished parents are set to BLOCKED automatically
 *   - BLOCKED tasks cannot be manually advanced to IN_PROGRESS or DONE;
 *     they must be unblocked first (all parents DONE) via the BFS workflow
 *   - Any status can transition to CANCELLED
 *   - DONE and CANCELLED are terminal — cannot be reversed via this endpoint
 */

import supabase from "../config/supabase.js";
import { wouldCreateCycle, orchestrateWorkflow } from "../algorithms.js";

// ─── List ────────────────────────────────────────────────────────────────────

export async function listTasks(req, res, next) {
  try {
    const { requirement_id, status, assignee_id, is_at_risk } = req.query;

    let query = supabase
      .from("tasks")
      .select(
        `id, title, description, status, priority, estimated_hours,
         is_at_risk, is_deprecated, is_ai_generated, created_at, updated_at,
         assignee:profiles!tasks_assignee_id_fkey(id, full_name),
         requirement:requirements(id, title, project_id)`,
      )
      .eq("is_deprecated", false)
      .order("created_at", { ascending: false });

    if (requirement_id) query = query.eq("requirement_id", requirement_id);
    if (status) query = query.eq("status", status);
    if (assignee_id) query = query.eq("assignee_id", assignee_id);
    if (is_at_risk !== undefined)
      query = query.eq("is_at_risk", is_at_risk === "true");

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ tasks: data });
  } catch (err) {
    next(err);
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createTask(req, res, next) {
  try {
    const {
      requirement_id,
      title,
      description,
      assignee_id,
      estimated_hours,
      priority,
    } = req.body;

    const { data, error } = await supabase
      .from("tasks")
      .insert({
        requirement_id,
        title,
        description,
        assignee_id: assignee_id || null,
        estimated_hours: estimated_hours || 0,
        priority: priority || "MEDIUM", // matches task-priority enum
        status: "TO_DO",
        is_ai_generated: false,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ task: data });
  } catch (err) {
    next(err);
  }
}

// ─── Get one ──────────────────────────────────────────────────────────────────

export async function getTask(req, res, next) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("tasks")
      .select(
        `*,
         assignee:profiles!tasks_assignee_id_fkey(id, full_name),
         requirement:requirements(id, title, project_id, status)`,
      )
      .eq("id", id)
      .single();

    if (error || !data)
      return res.status(404).json({ error: "Task not found." });
    res.json({ task: data });
  } catch (err) {
    next(err);
  }
}

// ─── Update metadata ──────────────────────────────────────────────────────────

export async function updateTask(req, res, next) {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      assignee_id,
      estimated_hours,
      priority,
      is_at_risk,
    } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (assignee_id !== undefined) updates.assignee_id = assignee_id;
    if (estimated_hours !== undefined)
      updates.estimated_hours = estimated_hours;
    if (priority !== undefined) updates.priority = priority;
    if (is_at_risk !== undefined) updates.is_at_risk = is_at_risk;

    const { data, error } = await supabase
      .from("tasks")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Task not found." });
    res.json({ task: data });
  } catch (err) {
    next(err);
  }
}

// ─── Update status (triggers BFS workflow automation) ─────────────────────────

export async function updateTaskStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const VALID_STATUSES = [
      "BLOCKED",
      "TO_DO",
      "IN_PROGRESS",
      "DONE",
      "CANCELLED",
    ];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    // Fetch current task to enforce transition rules
    const { data: current, error: fetchErr } = await supabase
      .from("tasks")
      .select("status")
      .eq("id", id)
      .single();

    if (fetchErr || !current)
      return res.status(404).json({ error: "Task not found." });

    // ── Status transition guards ──────────────────────────────────────────

    // BLOCKED tasks cannot be manually advanced to work states.
    // They must be unblocked by the BFS workflow (all parents completing).
    // CANCELLED is still allowed so a PM can cancel a blocked task.
    if (
      current.status === "BLOCKED" &&
      (status === "IN_PROGRESS" || status === "DONE")
    ) {
      return res.status(400).json({
        error:
          "Cannot start or complete a BLOCKED task. All parent dependencies must be DONE first.",
      });
    }

    // DONE is a terminal state — completed work should not be reversed.
    // If work genuinely needs to be redone, deprecate and recreate the task.
    if (current.status === "DONE" && status !== "DONE") {
      return res.status(400).json({
        error:
          "A DONE task cannot be moved to another status. Deprecate and recreate it if rework is needed.",
      });
    }

    // CANCELLED is a terminal state — cancelled work should not be reversed.
    if (current.status === "CANCELLED" && status !== "CANCELLED") {
      return res.status(400).json({
        error:
          "A CANCELLED task cannot be moved to another status. Deprecate and recreate it if the work is needed again.",
      });
    }

    // ─────────────────────────────────────────────────────────────────────

    const { data: updated, error } = await supabase
      .from("tasks")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!updated) return res.status(404).json({ error: "Task not found." });

    // BFS: when a task is completed, auto-unblock direct children
    // whose remaining parents are all DONE.
    let unblocked = [];
    if (status === "DONE") {
      unblocked = await orchestrateWorkflow(supabase, id);
    }

    res.json({ task: updated, unblocked });
  } catch (err) {
    next(err);
  }
}

// ─── Soft delete ──────────────────────────────────────────────────────────────

export async function deleteTask(req, res, next) {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("tasks")
      .update({ is_deprecated: true, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: "Task deprecated." });
  } catch (err) {
    next(err);
  }
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

/**
 * Handles both:
 *   GET /api/tasks/:id/dependencies    (req.params.id)
 *   GET /api/tasks/dependencies?task_id=  (req.query.task_id)
 */
export async function listDependencies(req, res, next) {
  try {
    // Support both path param (:id route) and query param (top-level route)
    const id = req.params.id || req.query.task_id;

    if (!id) {
      return res.status(400).json({
        error:
          "Task ID is required. Use /api/tasks/:id/dependencies or ?task_id=",
      });
    }

    const { data, error } = await supabase
      .from("task_dependencies")
      .select(
        `task_id, depends_on_task_id, is_ai_generated,
         task:tasks!task_dependencies_task_id_fkey(id, title, status),
         depends_on:tasks!task_dependencies_depends_on_task_id_fkey(id, title, status)`,
      )
      .or(`task_id.eq.${id},depends_on_task_id.eq.${id}`);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ dependencies: data });
  } catch (err) {
    next(err);
  }
}

export async function addDependency(req, res, next) {
  try {
    const { task_id, depends_on_task_id } = req.body;

    if (task_id === depends_on_task_id) {
      return res.status(400).json({ error: "A task cannot depend on itself." });
    }

    // Build current adjacency list for DFS (without the new edge)
    const { data: allDeps, error: depsErr } = await supabase
      .from("task_dependencies")
      .select("task_id, depends_on_task_id");

    if (depsErr) return res.status(500).json({ error: depsErr.message });

    const graph = {};
    for (const { task_id: t, depends_on_task_id: d } of allDeps) {
      if (!graph[t]) graph[t] = [];
      graph[t].push(d);
    }

    // DFS cycle detection — run against graph BEFORE inserting the edge.
    // wouldCreateCycle starts DFS at depends_on_task_id and checks whether
    // a path back to task_id already exists (which would form a cycle).
    if (wouldCreateCycle(graph, task_id, depends_on_task_id)) {
      return res.status(400).json({
        error:
          "This dependency would create a circular reference. Operation aborted.",
      });
    }

    const { data, error } = await supabase
      .from("task_dependencies")
      .insert({ task_id, depends_on_task_id, is_ai_generated: false })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res
          .status(409)
          .json({ error: "This dependency already exists." });
      }
      return res.status(500).json({ error: error.message });
    }

    // ─── Auto-block logic ────────────────────────────────────────────────
    // Fetch the parent task status. If the parent is not DONE, the child
    // must be BLOCKED. We only apply this to tasks that haven't been started
    // yet — IN_PROGRESS, DONE, and CANCELLED tasks are not regressed.
    const { data: parentTask, error: parentErr } = await supabase
      .from("tasks")
      .select("status")
      .eq("id", depends_on_task_id)
      .single();

    if (parentErr) {
      // Non-fatal: dependency is saved, but we couldn't evaluate block state.
      console.error(
        `[addDependency] Could not fetch parent task ${depends_on_task_id}: ${parentErr.message}`,
      );
      return res.status(201).json({ dependency: data });
    }

    if (parentTask.status !== "DONE") {
      const { error: blockErr } = await supabase
        .from("tasks")
        .update({ status: "BLOCKED", updated_at: new Date().toISOString() })
        .eq("id", task_id)
        .in("status", ["TO_DO", "BLOCKED"]); // never regress started/finished tasks

      if (blockErr) {
        console.error(
          `[addDependency] Could not block child task ${task_id}: ${blockErr.message}`,
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    res.status(201).json({ dependency: data });
  } catch (err) {
    next(err);
  }
}

export async function removeDependency(req, res, next) {
  try {
    const { task_id, depends_on_task_id } = req.params;

    const { error } = await supabase
      .from("task_dependencies")
      .delete()
      .eq("task_id", task_id)
      .eq("depends_on_task_id", depends_on_task_id);

    if (error) return res.status(500).json({ error: error.message });

    // ─── Re-evaluate child block state after dependency removal ──────────
    // If this was the last blocking parent (or all remaining parents are DONE),
    // the child task should be automatically unblocked (moved to TO_DO).
    const { data: remainingParents, error: parentsErr } = await supabase
      .from("task_dependencies")
      .select("depends_on:tasks!depends_on_task_id(status)")
      .eq("task_id", task_id);

    if (parentsErr) {
      console.error(
        `[removeDependency] Could not re-evaluate child task ${task_id}: ${parentsErr.message}`,
      );
      return res.json({ message: "Dependency removed." });
    }

    // Unblock the child if: no parents remain, OR all remaining parents are DONE.
    // Only touch the task if it is currently BLOCKED — leave any other status alone.
    const allParentsDone =
      remainingParents.length === 0 ||
      remainingParents.every((p) => p.depends_on?.status === "DONE");

    if (allParentsDone) {
      const { error: unblockErr } = await supabase
        .from("tasks")
        .update({ status: "TO_DO", updated_at: new Date().toISOString() })
        .eq("id", task_id)
        .eq("status", "BLOCKED");

      if (unblockErr) {
        console.error(
          `[removeDependency] Could not unblock child task ${task_id}: ${unblockErr.message}`,
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    res.json({ message: "Dependency removed." });
  } catch (err) {
    next(err);
  }
}
