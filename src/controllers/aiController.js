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
 */

import supabase from "../config/supabase.js";
import generateWBS from "../services/llmService.js";
import { validateTransition } from "../algorithms.js";

// ─── Phase 1: Generate preview ────────────────────────────────────────────────

export async function generateWBSPreview(req, res, next) {
  try {
    const { id: projectId } = req.params;

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

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: "tasks array is required." });
    }

    const idMap = {};

    // 1. Insert tasks
    for (const t of tasks) {
      // Check both temp dependencies AND existing dependencies
      const hasDependencies =
        (t.depends_on_temp_ids && t.depends_on_temp_ids.length > 0) ||
        (t.depends_on_existing_task_ids &&
          t.depends_on_existing_task_ids.length > 0);

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          requirement_id: t.requirement_id,
          title: t.title,
          description: t.description || null,
          assignee_id: t.assignee_id || null,
          estimated_hours: t.estimated_hours || 0,
          priority: t.priority || "MEDIUM",
          status: hasDependencies ? "BLOCKED" : "TO_DO",
          is_ai_generated: t.is_ai_generated ?? true,
        })
        .select("id")
        .single();

      if (error)
        return res
          .status(500)
          .json({ error: `Insert failed: ${error.message}` });
      idMap[t.temp_id] = data.id;
    }

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
      if (depErr)
        return res
          .status(500)
          .json({ error: `Deps failed: ${depErr.message}` });
    }

    // 3. Advance statuses for all affected requirements
    const uniqueReqIds = [
      ...new Set(tasks.map((t) => t.requirement_id).filter(Boolean)),
    ];

    if (uniqueReqIds.length > 0) {
      await supabase
        .from("requirements")
        .update({
          status: "IMPLEMENTATION",
          updated_at: new Date().toISOString(),
        })
        .in("id", uniqueReqIds)
        .eq("status", "APPROVED");

      const auditRows = uniqueReqIds.map((reqId) => ({
        requirement_id: reqId,
        old_status: "APPROVED",
        new_status: "IMPLEMENTATION",
        changed_by: req.user.id,
      }));
      await supabase.from("requirement_status_history").insert(auditRows);
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
