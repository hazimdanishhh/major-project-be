/**
 * algorithms.js
 * ---------------------------------------------------------------
 * Core graph & scheduling algorithms for the Project & Requirements
 * Management System (Major Project Blueprint, Section 13).
 *
 *   3     Requirement FSM transition validator
 *   8.1   DFS  - Circular dependency detection
 *   8.2   BFS  - Single-step workflow automation (unblocking)
 *   7     Impact analysis (flag affected tasks)
 *   9     CPM  - Critical path (forward / backward pass)
 *   8.3   AI WBS sanitization (uses DFS internally)
 *   10    Completion percentage tracking (project/requirement, Phase 10)
 *   14    Automated completion rollups (task -> requirement -> project)
 *
 * Pure functions are exported separately from DB-touching functions so
 * the pure ones (DFS, CPM, FSM, sanitizeWBS, completion tracking) can be
 * unit-tested with zero mocking - see TESTING_PLAN.md.
 * ---------------------------------------------------------------
 */

// ===================================================================
// 1. Requirement Lifecycle - Finite State Machine (Section 3)
// ===================================================================
export const REQUIREMENT_TRANSITIONS = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["UNDER_ANALYSIS"],
  UNDER_ANALYSIS: ["SPECIFICATION_DRAFTED"],
  SPECIFICATION_DRAFTED: ["CLIENT_VALIDATION"],
  CLIENT_VALIDATION: ["APPROVED", "UNDER_ANALYSIS"],
  APPROVED: ["IMPLEMENTATION", "UNDER_ANALYSIS"],
  IMPLEMENTATION: ["COMPLETED"],
  COMPLETED: [],
};

// Which role may manually trigger each edge above (client drives create/submit/
// validation-decision, pm drives the internal analysis stages) — see
// PROCESS_FLOW.md Section 3. Every edge in REQUIREMENT_TRANSITIONS has an
// entry here.
export const REQUIREMENT_TRANSITION_ROLES = {
  DRAFT: { SUBMITTED: ["client"] },
  SUBMITTED: { UNDER_ANALYSIS: ["pm"] },
  UNDER_ANALYSIS: { SPECIFICATION_DRAFTED: ["pm"] },
  SPECIFICATION_DRAFTED: { CLIENT_VALIDATION: ["pm"] },
  CLIENT_VALIDATION: { APPROVED: ["client"], UNDER_ANALYSIS: ["client"] },
  APPROVED: { IMPLEMENTATION: ["pm"], UNDER_ANALYSIS: ["client"] },
  IMPLEMENTATION: { COMPLETED: ["pm"], UNDER_ANALYSIS: ["client"] },
};

// Thrown by validateTransition when the FSM shape is valid but the calling
// role isn't the one allowed to trigger this specific edge — distinct from
// the generic Error thrown for a shape violation so callers can tell a
// "wrong state" 400 apart from a "wrong role" 403.
export class ForbiddenTransitionError extends Error {}

/**
 * Throws if currentStatus -> newStatus is not an allowed FSM transition.
 * When `role` is provided, also throws a ForbiddenTransitionError if that
 * role isn't permitted to trigger this specific edge
 * (REQUIREMENT_TRANSITION_ROLES). Omitting `role` skips that check entirely,
 * so callers that only care about FSM shape (e.g. a unit test) can still
 * call this with two arguments.
 * @returns {true} if valid
 */
export function validateTransition(currentStatus, newStatus, role) {
  const allowed = REQUIREMENT_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid requirement transition: '${currentStatus}' -> '${newStatus}'. ` +
        `Allowed next states: [${allowed.join(", ") || "none"}]`,
    );
  }

  if (role !== undefined) {
    const allowedRoles = REQUIREMENT_TRANSITION_ROLES[currentStatus]?.[newStatus] || [];
    if (!allowedRoles.includes(role)) {
      throw new ForbiddenTransitionError(
        `Role '${role}' cannot perform the transition '${currentStatus}' -> '${newStatus}'. ` +
          `Allowed role(s): [${allowedRoles.join(", ") || "none"}]`,
      );
    }
  }

  return true;
}

// ===================================================================
// 2. DFS - Circular Dependency Detection (Section 8.1)
// ===================================================================
/**
 * Checks whether adding the edge (taskId -> dependsOnId) would create a
 * cycle in the dependency graph (i.e. dependsOnId already transitively
 * depends on taskId).
 *
 * @param {Object<string,string[]>} graph - adjacency list:
 *        { taskId: [dependsOnId, ...] }
 * @param {string} taskId      - the task that would gain a new dependency
 * @param {string} dependsOnId - the task it would depend on
 * @returns {boolean} true if a cycle would be created
 *
 * Complexity: O(V + E)
 */
export function wouldCreateCycle(graph, taskId, dependsOnId) {
  if (taskId === dependsOnId) return true; // self-dependency is a 1-node cycle

  const visited = new Set();

  function dfs(node) {
    if (node === taskId) return true; // found a path back to taskId -> cycle
    if (visited.has(node)) return false;
    visited.add(node);
    const deps = graph[node] || [];
    return deps.some(dfs);
  }

  return dfs(dependsOnId);
}

// ===================================================================
// 3. BFS - Single-Step Workflow Automation (Section 8.2)
// ===================================================================
/**
 * After a task transitions to 'Done', find its direct children and
 * unblock any whose remaining parent dependencies are now all 'Done'.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {string} completedTaskId
 * @returns {Promise<string[]>} ids of tasks that were unblocked
 */
export async function orchestrateWorkflow(db, completedTaskId) {
  const unblocked = [];

  const { data: children, error: e1 } = await db
    .from("task_dependencies")
    .select("task_id")
    .eq("depends_on_task_id", completedTaskId);

  if (e1) throw e1;
  if (!children?.length) return unblocked;

  for (const { task_id } of children) {
    const { data: parentLinks, error: e2 } = await db
      .from("task_dependencies")
      .select("depends_on:tasks!depends_on_task_id(status)")
      .eq("task_id", task_id);

    if (e2) throw e2;

    const allParentsDone = parentLinks.every(
      (p) => p.depends_on?.status === "DONE",
    );

    if (allParentsDone) {
      const { error: e3 } = await db
        .from("tasks")
        .update({ status: "TO_DO" })
        .eq("id", task_id)
        .eq("status", "BLOCKED"); // only move tasks that were actually Blocked

      if (e3) throw e3;
      unblocked.push(task_id);
    }
  }

  return unblocked;
}

// ===================================================================
// 4. Impact Analysis (Section 7)
// ===================================================================
/**
 * Marks every non-deprecated task linked to a requirement as 'at risk'.
 * Call this whenever an Approved/Implementation requirement is edited.
 *
 * @returns {Promise<string[]>} ids of tasks flagged
 */
export async function flagImpactedTasks(db, requirementId) {
  const { data: tasks, error } = await db
    .from("tasks")
    .select("id")
    .eq("requirement_id", requirementId)
    .eq("is_deprecated", false);

  if (error) throw error;
  if (!tasks?.length) return [];

  const ids = tasks.map((t) => t.id);

  const { error: updErr } = await db
    .from("tasks")
    .update({ is_at_risk: true })
    .in("id", ids);

  if (updErr) throw updErr;
  return ids;
}

// ===================================================================
// 5. Topological Sort (Kahn's Algorithm) - prerequisite for CPM
// ===================================================================
/**
 * @param {string[]} taskIds
 * @param {{task_id:string, depends_on_task_id:string}[]} dependencies
 * @returns {string[]} a valid topological ordering
 * @throws if the graph contains a cycle
 */
export function topoSort(taskIds, dependencies) {
  const inDegree = {};
  const adj = {};

  taskIds.forEach((id) => {
    inDegree[id] = 0;
    adj[id] = [];
  });

  dependencies.forEach(({ task_id, depends_on_task_id }) => {
    adj[depends_on_task_id].push(task_id);
    inDegree[task_id] = (inDegree[task_id] || 0) + 1;
  });

  const queue = taskIds.filter((id) => inDegree[id] === 0);
  const order = [];

  while (queue.length) {
    const node = queue.shift();
    order.push(node);
    for (const next of adj[node]) {
      inDegree[next] -= 1;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  if (order.length !== taskIds.length) {
    throw new Error("Graph contains a cycle - cannot compute critical path");
  }

  return order;
}

// ===================================================================
// 6. CPM - Critical Path Method, Forward & Backward Pass (Section 9)
// ===================================================================
/**
 * @param {{id:string, estimated_hours:number}[]} tasks
 * @param {{task_id:string, depends_on_task_id:string}[]} dependencies
 * @returns {{schedule: object[], criticalPath: string[], projectDuration: number}}
 *
 * Complexity: O(V + E)
 */
export function calculateCriticalPath(tasks, dependencies) {
  const taskIds = tasks.map((t) => t.id);
  const hours = Object.fromEntries(
    tasks.map((t) => [t.id, t.estimated_hours || 0]),
  );

  const parents = {};
  const children = {};
  taskIds.forEach((id) => {
    parents[id] = [];
    children[id] = [];
  });

  dependencies.forEach(({ task_id, depends_on_task_id }) => {
    parents[task_id].push(depends_on_task_id);
    children[depends_on_task_id].push(task_id);
  });

  const order = topoSort(taskIds, dependencies);

  // --- Forward pass: Early Start (ES) / Early Finish (EF) ---
  const ES = {};
  const EF = {};
  for (const id of order) {
    const parentEFs = parents[id].map((p) => EF[p]);
    ES[id] = parentEFs.length ? Math.max(...parentEFs) : 0;
    EF[id] = ES[id] + hours[id];
  }

  const projectDuration = Math.max(0, ...Object.values(EF));

  // --- Backward pass: Late Finish (LF) / Late Start (LS) ---
  const LF = {};
  const LS = {};
  for (const id of [...order].reverse()) {
    const childLSs = children[id].map((c) => LS[c]);
    LF[id] = childLSs.length ? Math.min(...childLSs) : projectDuration;
    LS[id] = LF[id] - hours[id];
  }

  const schedule = taskIds.map((id) => ({
    id,
    ES: ES[id],
    EF: EF[id],
    LS: LS[id],
    LF: LF[id],
    float: LS[id] - ES[id],
  }));

  const criticalPath = schedule.filter((t) => t.float === 0).map((t) => t.id);

  return { schedule, criticalPath, projectDuration };
}

// ===================================================================
// 7. AI WBS Sanitization (Section 8.3, step 4)
// ===================================================================
/**
 * Strips any AI-proposed dependency edges (referenced by temp_id) that
 * would create a cycle, using the same DFS check as wouldCreateCycle.
 * Run this on the raw LLM JSON output BEFORE showing it to the PM.
 *
 * @param {{temp_id:string, depends_on_temp_ids?:string[]}[]} rawTasks
 * @returns {object[]} tasks with cleaned depends_on_temp_ids + is_ai_generated: true
 */
const VALID_TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function sanitizeWBS(rawTasks) {
  // Drop any task with a missing/empty title before it can enter the
  // dependency graph or reach the DB — an untitled task would otherwise
  // fail the DB's NOT NULL constraint with a raw error at persist time.
  const validTasks = rawTasks.filter(
    (t) => typeof t.title === "string" && t.title.trim().length > 0,
  );

  const graph = {};
  validTasks.forEach((t) => {
    graph[t.temp_id] = [];
  });

  return validTasks.map((t) => {
    const safeDeps = [];
    for (const depId of t.depends_on_temp_ids || []) {
      if (!graph[depId]) continue; // ignore references to unknown/dropped temp_ids

      graph[t.temp_id].push(depId); // tentatively add edge
      if (wouldCreateCycle(graph, t.temp_id, depId)) {
        graph[t.temp_id].pop(); // hallucinated cycle - silently drop it
        continue;
      }
      safeDeps.push(depId);
    }

    // Normalize fields the LLM might hallucinate outside their valid range —
    // otherwise a bad value only surfaces as a raw DB constraint-violation
    // error at persist time instead of a clean fallback.
    const priority = VALID_TASK_PRIORITIES.includes(t.priority)
      ? t.priority
      : "MEDIUM";
    const estimated_hours =
      Number.isInteger(t.estimated_hours) && t.estimated_hours >= 0
        ? t.estimated_hours
        : 0;

    return {
      ...t,
      priority,
      estimated_hours,
      depends_on_temp_ids: safeDeps,
      is_ai_generated: true,
    };
  });
}

// ===================================================================
// 8. Completion Percentage Tracking (Phase 10)
// ===================================================================
/**
 * A project's completion — the fraction of its requirements that are
 * COMPLETED. Note: deleteRequirement soft-deletes by setting status to
 * COMPLETED too, so a deleted requirement is indistinguishable from a
 * genuinely-finished one here — a known, documented limitation, not a bug.
 *
 * @param {{status:string}[]} requirements
 * @returns {{total:number, completed:number, percentage:number}}
 */
export function calculateProjectCompletion(requirements) {
  const total = requirements.length;
  const completed = requirements.filter((r) => r.status === "COMPLETED").length;
  return {
    total,
    completed,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

/**
 * A requirement's completion — the fraction of its in-scope tasks that are
 * DONE. Deprecated tasks (superseded by a requirement content-edit revert)
 * and CANCELLED tasks are excluded from both the numerator and denominator
 * entirely — cancelling is treated as descoping the work, not failing to
 * finish it.
 *
 * @param {{status:string, is_deprecated?:boolean}[]} tasks
 * @returns {{total:number, completed:number, percentage:number}}
 */
export function calculateRequirementCompletion(tasks) {
  const scoped = tasks.filter((t) => !t.is_deprecated && t.status !== "CANCELLED");
  const total = scoped.length;
  const completed = scoped.filter((t) => t.status === "DONE").length;
  return {
    total,
    completed,
    percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

// ===================================================================
// 9. Automated Completion Rollups (Phase 14)
// ===================================================================
/**
 * If `requirementId` is currently IMPLEMENTATION and every one of its
 * in-scope tasks (same DONE/CANCELLED-excluded scoping as
 * calculateRequirementCompletion) is DONE, advances it to COMPLETED and
 * records the transition in requirement_status_history. No-op if the
 * requirement isn't IMPLEMENTATION, has zero in-scope tasks, or isn't yet
 * 100% complete — an empty task set must never auto-complete.
 *
 * `changedBy` is the user whose action (completing/cancelling a task)
 * tipped the requirement over — the audit trail credits that human action
 * directly rather than a synthetic "system" actor.
 *
 * @returns {Promise<{id:string, project_id:string}|null>} the completed
 *   requirement's id/project_id if it was just auto-completed, else null.
 */
export async function maybeAutoCompleteRequirement(db, requirementId, changedBy) {
  const { data: requirement, error: reqErr } = await db
    .from("requirements")
    .select("status, project_id")
    .eq("id", requirementId)
    .single();

  if (reqErr || !requirement || requirement.status !== "IMPLEMENTATION") {
    return null;
  }

  const { data: tasks, error: tasksErr } = await db
    .from("tasks")
    .select("status, is_deprecated")
    .eq("requirement_id", requirementId);

  if (tasksErr) throw tasksErr;

  const completion = calculateRequirementCompletion(tasks || []);
  if (completion.total === 0 || completion.percentage !== 100) return null;

  // System-triggered edge — no role check (mirrors persistWBS's
  // APPROVED -> IMPLEMENTATION auto-advance, which calls validateTransition
  // with no role argument for the same reason: there's no human actor
  // choosing this specific transition to validate against).
  validateTransition("IMPLEMENTATION", "COMPLETED");

  const { data: updated, error: updateErr } = await db
    .from("requirements")
    .update({ status: "COMPLETED", updated_at: new Date().toISOString() })
    .eq("id", requirementId)
    .eq("status", "IMPLEMENTATION") // re-check at write time to avoid a race
    .select("id, project_id")
    .single();

  if (updateErr || !updated) return null; // 0 rows changed - another request beat us to it

  await db.from("requirement_status_history").insert({
    requirement_id: requirementId,
    old_status: "IMPLEMENTATION",
    new_status: "COMPLETED",
    changed_by: changedBy,
  });

  return updated;
}

/**
 * If `projectId` is currently ACTIVE and every one of its requirements is
 * COMPLETED, advances the project to COMPLETED. No-op if the project isn't
 * ACTIVE, has zero requirements, or isn't yet 100% complete. A PM's
 * deliberate ON_HOLD/ARCHIVED call is never silently overridden by this.
 *
 * Projects have no status_history table, so no audit row is written here —
 * matches updateProject/deleteProject, which also write `status` directly
 * with no history log.
 *
 * Inherits calculateProjectCompletion's known, documented limitation: a
 * soft-deleted requirement (deleteRequirement sets status: COMPLETED on
 * archive) counts identically to a genuinely-finished one, so a project
 * whose requirements were all archived rather than finished can also
 * auto-complete here. Accepted, not fixed (see README.md's Completion
 * Tracking section).
 *
 * @returns {Promise<{id:string}|null>}
 */
export async function maybeAutoCompleteProject(db, projectId) {
  const { data: project, error: projErr } = await db
    .from("projects")
    .select("status")
    .eq("id", projectId)
    .single();

  if (projErr || !project || project.status !== "ACTIVE") return null;

  const { data: requirements, error: reqErr } = await db
    .from("requirements")
    .select("status")
    .eq("project_id", projectId);

  if (reqErr) throw reqErr;

  const completion = calculateProjectCompletion(requirements || []);
  if (completion.total === 0 || completion.percentage !== 100) return null;

  const { data: updated, error: updateErr } = await db
    .from("projects")
    .update({ status: "COMPLETED", updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("status", "ACTIVE") // re-check at write time to avoid a race
    .select("id")
    .single();

  if (updateErr || !updated) return null;
  return updated;
}
