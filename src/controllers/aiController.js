/**
 * src/controllers/aiController.js
 *
 * Two-phase AI WBS generation (Human-in-the-Loop):
 *
 *   POST /api/projects/:id/generate-wbs
 *     → Calls Groq LLM, sanitizes output with DFS, returns preview.
 *       Nothing is saved to the DB. PM can edit before confirming.
 *
 *   POST /api/projects/:id/persist-wbs
 *     → Accepts the (optionally PM-edited) task list, inserts tasks
 *       and dependencies using real UUIDs. The temp_id→UUID mapping
 *       is resolved here. Auto-advances requirement to IMPLEMENTATION
 *       via the FSM validator and records the transition in the audit trail.
 *
 * Both handlers are scoped to projects the caller can see (getVisibleProjectIds,
 * src/utils/projectAccess.js) before doing anything else — a pm may only
 * generate/persist a WBS against their own project, mirroring the tenant
 * isolation every other controller already applies.
 */

import supabase from "../config/supabase.js";
import generateWBS from "../services/llmService.js";
import { maybeAutoStartImplementation } from "../algorithms.js";
import { getVisibleProjectIds, isProjectMember } from "../utils/projectAccess.js";

// ─── Phase 1: Generate preview ────────────────────────────────────────────────

export async function generateWBSPreview(req, res, next) {
  try {
    const { id: projectId } = req.params;

    const visibleProjectIds = await getVisibleProjectIds(req.user);
    if (!visibleProjectIds.includes(projectId)) {
      return res.status(404).json({ error: "Project not found." });
    }

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .single();

    if (projErr || !project)
      return res.status(404).json({ error: "Project not found." });

    const { data: requirements, error: reqErr } = await supabase
      .from("requirements")
      .select("*")
      .eq("project_id", projectId)
      .eq("status", "APPROVED");

    if (reqErr || !requirements?.length) {
      return res
        .status(400)
        .json({ error: "No APPROVED requirements found for this project." });
    }

    const reqIds = requirements.map((r) => r.id);

    const { data: specs, error: specErr } = await supabase
      .from("requirement_specifications")
      .select("*")
      .in("requirement_id", reqIds)
      .eq("status", "FINAL");

    if (specErr || !specs?.length) {
      return res.status(400).json({
        error: "No finalized specifications found for these requirements.",
      });
    }

    // First get all project requirements (even non-approved ones) to find all existing tasks
    const { data: allReqs } = await supabase
      .from("requirements")
      .select("id")
      .eq("project_id", projectId);

    let existingTasks = [];
    if (allReqs?.length) {
      const allReqIds = allReqs.map((r) => r.id);
      const { data: eTasks } = await supabase
        .from("tasks")
        .select("id, title, status")
        .in("requirement_id", allReqIds);
      existingTasks = eTasks || [];
    }
    // ---------------------------------------------------------

    // Pass existingTasks into the LLM
    const tasks = await generateWBS(
      project,
      requirements,
      specs,
      existingTasks,
    );

    res.json({
      tasks,
      message:
        "Review and edit these AI-generated project tasks before saving.",
    });
  } catch (err) {
    if (err.message?.includes("LLM"))
      return res.status(502).json({ error: err.message });
    next(err);
  }
}

// ─── Phase 2: Persist after PM review ────────────────────────────────────────

export async function persistWBS(req, res, next) {
  try {
    const { id: projectId } = req.params;
    const { tasks } = req.body;

    const visibleProjectIds = await getVisibleProjectIds(req.user);
    if (!visibleProjectIds.includes(projectId)) {
      return res.status(404).json({ error: "Project not found." });
    }

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: "tasks array is required." });
    }

    // 0. Verify every requirement_id in the payload belongs to THIS project,
    // and capture each one's current status for the FSM-gated advance below.
    const incomingReqIds = [
      ...new Set(tasks.map((t) => t.requirement_id).filter(Boolean)),
    ];

    const { data: projectReqs, error: reqCheckErr } = await supabase
      .from("requirements")
      .select("id, status")
      .eq("project_id", projectId)
      .in("id", incomingReqIds);

    if (reqCheckErr) {
      return next(reqCheckErr);
    }

    const reqStatusMap = new Map(
      (projectReqs || []).map((r) => [r.id, r.status]),
    );
    const invalidReqIds = incomingReqIds.filter(
      (rid) => !reqStatusMap.has(rid),
    );

    if (invalidReqIds.length > 0) {
      return res.status(400).json({
        error:
          `The following requirement_id(s) do not belong to project ${projectId}: ` +
          invalidReqIds.join(", "),
      });
    }

    const completedReqIds = incomingReqIds.filter(
      (rid) => reqStatusMap.get(rid) === "COMPLETED",
    );
    if (completedReqIds.length > 0) {
      return res.status(400).json({
        error:
          `Cannot add tasks to COMPLETED requirement(s): ` +
          completedReqIds.join(", "),
      });
    }

    // 0b. Every assignee named in the payload must be on this project's team
    // (project_members) — same rule taskController.js's createTask/updateTask
    // enforce, so AI WBS persistence can't be used to bypass it.
    const incomingAssigneeIds = [
      ...new Set(tasks.map((t) => t.assignee_id).filter(Boolean)),
    ];
    for (const assigneeId of incomingAssigneeIds) {
      const isMember = await isProjectMember(projectId, assigneeId);
      if (!isMember) {
        return res.status(400).json({
          error: `Assignee ${assigneeId} is not a member of this project.`,
        });
      }
    }

    // 1. Insert all tasks in a single bulk insert — one INSERT statement is
    // atomic, so either every task is created or none are (no orphaned
    // partial-WBS rows if one task's data is bad).
    const taskRows = tasks.map((t) => {
      const hasDependencies =
        (t.depends_on_temp_ids && t.depends_on_temp_ids.length > 0) ||
        (t.depends_on_existing_task_ids &&
          t.depends_on_existing_task_ids.length > 0);

      return {
        requirement_id: t.requirement_id,
        title: t.title,
        description: t.description || null,
        assignee_id: t.assignee_id || null,
        estimated_hours: t.estimated_hours || 0,
        priority: t.priority || "MEDIUM",
        status: hasDependencies ? "BLOCKED" : "TO_DO",
        is_ai_generated: t.is_ai_generated ?? true,
      };
    });

    const { data: insertedTasks, error: insertErr } = await supabase
      .from("tasks")
      .insert(taskRows)
      .select("id");

    if (insertErr) return next(insertErr);

    // A single multi-row INSERT ... RETURNING preserves the order of the
    // VALUES list, so zipping by index is safe.
    const idMap = {};
    tasks.forEach((t, i) => {
      idMap[t.temp_id] = insertedTasks[i].id;
    });

    // 2. Insert dependencies
    const depRows = [];
    for (const t of tasks) {
      // A. Dependencies on other NEW tasks
      for (const depTempId of t.depends_on_temp_ids || []) {
        if (!idMap[depTempId]) continue;
        depRows.push({
          task_id: idMap[t.temp_id],
          depends_on_task_id: idMap[depTempId],
          is_ai_generated: true,
        });
      }

      // B. Dependencies on EXISTING database tasks
      for (const existingId of t.depends_on_existing_task_ids || []) {
        depRows.push({
          task_id: idMap[t.temp_id],
          depends_on_task_id: existingId, // This is already a real UUID
          is_ai_generated: true,
        });
      }
    }

    if (depRows.length > 0) {
      const { error: depErr } = await supabase
        .from("task_dependencies")
        .insert(depRows);
      if (depErr) return next(depErr);
    }

    // 3. Advance status for requirements that are currently APPROVED, via
    // the same shared helper createTask uses for manually-created tasks —
    // a requirement's first task (however it got there) is what starts
    // implementation, not a separate AI-WBS-only code path.
    for (const reqId of incomingReqIds) {
      await maybeAutoStartImplementation(supabase, reqId, req.user.id);
    }

    res.status(201).json({
      message: "Global Project WBS persisted successfully.",
      created_task_ids: Object.values(idMap),
      dependency_count: depRows.length,
    });
  } catch (err) {
    next(err);
  }
}
