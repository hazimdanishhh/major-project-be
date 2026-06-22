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
 *
 * Pure functions are exported separately from DB-touching functions so
 * the pure ones (DFS, CPM, FSM, sanitizeWBS) can be unit-tested with
 * zero mocking - see TESTING section of the implementation guide.
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

/**
 * Throws if currentStatus -> newStatus is not an allowed FSM transition.
 * @returns {true} if valid
 */
export function validateTransition(currentStatus, newStatus) {
  const allowed = REQUIREMENT_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid requirement transition: '${currentStatus}' -> '${newStatus}'. ` +
        `Allowed next states: [${allowed.join(", ") || "none"}]`,
    );
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
export function sanitizeWBS(rawTasks) {
  const graph = {};
  rawTasks.forEach((t) => {
    graph[t.temp_id] = [];
  });

  return rawTasks.map((t) => {
    const safeDeps = [];
    for (const depId of t.depends_on_temp_ids || []) {
      if (!graph[depId]) continue; // ignore references to unknown temp_ids

      graph[t.temp_id].push(depId); // tentatively add edge
      if (wouldCreateCycle(graph, t.temp_id, depId)) {
        graph[t.temp_id].pop(); // hallucinated cycle - silently drop it
        continue;
      }
      safeDeps.push(depId);
    }
    return { ...t, depends_on_temp_ids: safeDeps, is_ai_generated: true };
  });
}
