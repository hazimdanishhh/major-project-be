/**
 * src/controllers/algorithmController.js
 *
 * Exposes the pure algorithm outputs as API endpoints.
 *
 * Routes:
 *   GET /api/projects/:id/critical-path   — CPM: forward/backward pass
 *   GET /api/traceability?project_id=     — RTM from the SQL view
 */

import supabase from "../config/supabase.js";
import { calculateCriticalPath } from "../algorithms.js";

/**
 * GET /api/projects/:id/critical-path
 *
 * Fetches all schedulable tasks for the project (non-deprecated, non-cancelled),
 * fetches their dependencies (filtered to only edges between project tasks),
 * runs the CPM forward/backward pass, and returns the schedule + critical
 * path node IDs + project duration.
 *
 * CANCELLED tasks are excluded because they represent abandoned work that
 * should not influence the project's schedule or critical path.
 * DONE tasks ARE included — their estimated_hours still represent the
 * actual time block they held, which is needed for a correct CPM calculation.
 */
export async function criticalPath(req, res, next) {
  try {
    const { id: projectId } = req.params;

    // Pull tasks via requirement → project join.
    // Exclude deprecated tasks (removed from scope) and CANCELLED tasks
    // (abandoned work — not part of the schedule).
    const { data: tasks, error: tasksErr } = await supabase
      .from("tasks")
      .select(
        "id, title, estimated_hours, status, requirement:requirements!inner(project_id)",
      )
      .eq("requirement.project_id", projectId)
      .eq("is_deprecated", false)
      .neq("status", "CANCELLED");

    if (tasksErr) return res.status(500).json({ error: tasksErr.message });
    if (!tasks || tasks.length === 0) {
      return res.json({ schedule: [], criticalPath: [], projectDuration: 0 });
    }

    const taskIds = tasks.map((t) => t.id);

    // Fetch only dependencies where BOTH endpoints are active project tasks.
    // This prevents a stale dependency on a deprecated or cross-project task
    // from causing undefined EF/ES values in the CPM forward pass (which would
    // crash calculateCriticalPath with a NaN propagation).
    const { data: deps, error: depsErr } = await supabase
      .from("task_dependencies")
      .select("task_id, depends_on_task_id")
      .in("task_id", taskIds)
      .in("depends_on_task_id", taskIds);

    if (depsErr) return res.status(500).json({ error: depsErr.message });

    try {
      const result = calculateCriticalPath(tasks, deps || []);

      // Enrich schedule entries with task titles and status for frontend
      const taskMeta = Object.fromEntries(
        tasks.map((t) => [t.id, { title: t.title, status: t.status }]),
      );
      const enrichedSchedule = result.schedule.map((entry) => ({
        ...entry,
        title: taskMeta[entry.id]?.title,
        status: taskMeta[entry.id]?.status,
      }));

      res.json({ ...result, schedule: enrichedSchedule });
    } catch (cpmErr) {
      // Cycle detected — should not happen if DFS guard is working, but
      // return a clear 400 so the frontend can surface the message.
      res.status(400).json({ error: cpmErr.message });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/traceability?project_id=
 *
 * Returns rows from the `traceability_matrix` view.
 * Rows with is_at_risk=true indicate a "Suspect Link" (Section 7).
 */
export async function traceabilityMatrix(req, res, next) {
  try {
    const { project_id } = req.query;

    let query = supabase.from("traceability_matrix").select("*");
    if (project_id) query = query.eq("project_id", project_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ matrix: data });
  } catch (err) {
    next(err);
  }
}
