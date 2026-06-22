/**
 * src/controllers/requirementController.js
 *
 * Routes:
 *   GET    /api/requirements?project_id=  — list requirements for a project
 *   POST   /api/requirements              — create a requirement (pm, client)
 *   GET    /api/requirements/:id          — get single requirement + history
 *   PATCH  /api/requirements/:id          — update content OR advance FSM status
 *   DELETE /api/requirements/:id          — soft delete (pm only)
 *
 *   GET    /api/requirements/:id/versions — version history
 *   GET    /api/requirements/:id/history  — status change audit trail
 *
 *   POST   /api/requirements/:id/specs          — create specification (pm)
 *   PATCH  /api/requirements/:id/specs/:spec_id — update specification (pm)
 *
 * Process flow:
 *   DRAFT → SUBMITTED → UNDER_ANALYSIS → SPECIFICATION_DRAFTED
 *     → CLIENT_VALIDATION → APPROVED → IMPLEMENTATION → COMPLETED
 *
 *   Specifications can only be created/edited while the requirement is in
 *   UNDER_ANALYSIS or SPECIFICATION_DRAFTED — the states where analysis work
 *   is actively being done. Creating a spec at DRAFT/SUBMITTED makes no
 *   process sense, and creating one at APPROVED/IMPLEMENTATION would bypass
 *   the review cycle.
 *
 *   Content edits on APPROVED/IMPLEMENTATION requirements trigger:
 *     1. Status revert to UNDER_ANALYSIS
 *     2. Version bump + new requirement_versions row
 *     3. Impact analysis — all linked tasks flagged as at-risk
 */

import supabase from "../config/supabase.js";
import { validateTransition, flagImpactedTasks } from "../algorithms.js";

// ─── List ────────────────────────────────────────────────────────────────────

export async function listRequirements(req, res, next) {
  try {
    const { project_id, status } = req.query;

    let query = supabase
      .from("requirements")
      .select(
        `id, title, description, status, current_version, created_at, updated_at,
         created_by:profiles!requirements_created_by_fkey(id, full_name)`,
      )
      .order("created_at", { ascending: false });

    if (project_id) query = query.eq("project_id", project_id);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ requirements: data });
  } catch (err) {
    next(err);
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createRequirement(req, res, next) {
  try {
    const { project_id, title, description } = req.body;

    const { data, error } = await supabase
      .from("requirements")
      .insert({
        project_id,
        title,
        description,
        status: "DRAFT",
        current_version: 1,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Record initial version in audit trail
    await supabase.from("requirement_versions").insert({
      requirement_id: data.id,
      version_no: 1,
      title: data.title,
      description: data.description,
      changed_by: req.user.id,
    });

    res.status(201).json({ requirement: data });
  } catch (err) {
    next(err);
  }
}

// ─── Get one ──────────────────────────────────────────────────────────────────

export async function getRequirement(req, res, next) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("requirements")
      .select(
        `*, 
         created_by_user:profiles!requirements_created_by_fkey(id, full_name),
         requirement_specifications(*),
         tasks(id, title, status, is_at_risk, is_ai_generated, assignee:profiles!tasks_assignee_id_fkey(id, full_name))`,
      )
      .eq("id", id)
      .single();

    if (error || !data)
      return res.status(404).json({ error: "Requirement not found." });
    res.json({ requirement: data });
  } catch (err) {
    next(err);
  }
}

// ─── Update (FSM + content edit + versioning + impact analysis) ───────────────

export async function updateRequirement(req, res, next) {
  try {
    const { id } = req.params;
    const { title, description, new_status } = req.body;

    // Fetch current state
    const { data: current, error: fetchErr } = await supabase
      .from("requirements")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !current) {
      return res.status(404).json({ error: "Requirement not found." });
    }

    const isContentChange = title !== undefined || description !== undefined;
    const isStatusChange = new_status && new_status !== current.status;

    // ── Guard: disallow simultaneous status advance + content edit ────────
    // These are separate operations with different side-effects:
    //   - content edit on APPROVED/IMPLEMENTATION reverts status to UNDER_ANALYSIS
    //   - a status advance must go through the FSM
    // Allowing both in one request creates an ambiguous outcome.
    if (isStatusChange && isContentChange) {
      return res.status(400).json({
        error:
          "Cannot change status and edit content in the same request. " +
          "Submit them as separate operations.",
      });
    }

    let targetStatus = current.status;
    const updates = { updated_at: new Date().toISOString() };

    // ── Step 1: Validate FSM transition if status change is requested ──────
    if (isStatusChange) {
      try {
        validateTransition(current.status, new_status);
        targetStatus = new_status;
        updates.status = targetStatus;
      } catch (fsmErr) {
        return res.status(400).json({ error: fsmErr.message });
      }
    }

    // ── Step 2: Content change handling ───────────────────────────────────
    if (isContentChange) {
      const newTitle = title ?? current.title;
      const newDescription = description ?? current.description;

      // Only treat as a real content change if values actually differ.
      // Sending identical values must not trigger versioning or impact analysis.
      const titleChanged = title !== undefined && title !== current.title;
      const descriptionChanged =
        description !== undefined && description !== current.description;
      const contentActuallyChanged = titleChanged || descriptionChanged;

      if (contentActuallyChanged) {
        updates.title = newTitle;
        updates.description = newDescription;

        // Change-control: editing an APPROVED or IN-IMPLEMENTATION requirement
        // reverts it to UNDER_ANALYSIS and triggers impact analysis.
        if (["APPROVED", "IMPLEMENTATION"].includes(current.status)) {
          targetStatus = "UNDER_ANALYSIS";
          updates.status = targetStatus;
          updates.current_version = current.current_version + 1;

          await supabase.from("requirement_versions").insert({
            requirement_id: id,
            version_no: updates.current_version,
            title: newTitle,
            description: newDescription,
            changed_by: req.user.id,
          });

          // Section 7: Flag all linked non-deprecated tasks as at-risk
          await flagImpactedTasks(supabase, id);
        } else {
          // Pre-approval edits (DRAFT, SUBMITTED, etc.) — just update content,
          // no version bump or impact analysis needed.
          updates.title = newTitle;
          updates.description = newDescription;
        }
      }
    }

    // ── Step 3: Persist the update ────────────────────────────────────────
    const { data: updated, error: updateErr } = await supabase
      .from("requirements")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // ── Step 4: Audit trail for status change ─────────────────────────────
    if (targetStatus !== current.status) {
      await supabase.from("requirement_status_history").insert({
        requirement_id: id,
        old_status: current.status,
        new_status: targetStatus,
        changed_by: req.user.id,
      });
    }

    res.json({ requirement: updated });
  } catch (err) {
    next(err);
  }
}

// ─── Delete (soft) ────────────────────────────────────────────────────────────
// Hard-deleting would cascade-destroy requirement_versions and
// requirement_status_history, losing the full audit trail. Instead:
//   1. Soft-delete all linked tasks (is_deprecated = true)
//   2. Set requirement status to COMPLETED (terminal FSM state)
//   3. Record the final status change in the audit trail
// The requirement remains queryable; active project views should filter
// on status != 'COMPLETED' to exclude archived requirements.

export async function deleteRequirement(req, res, next) {
  try {
    const { id } = req.params;

    // 1. Soft-delete all linked tasks
    const { error: tasksErr } = await supabase
      .from("tasks")
      .update({ is_deprecated: true, updated_at: new Date().toISOString() })
      .eq("requirement_id", id);

    if (tasksErr) return res.status(500).json({ error: tasksErr.message });

    // 2. Fetch current status for audit trail
    const { data: current, error: fetchErr } = await supabase
      .from("requirements")
      .select("status")
      .eq("id", id)
      .single();

    if (fetchErr || !current)
      return res.status(404).json({ error: "Requirement not found." });

    // 3. Soft-delete the requirement by marking it COMPLETED
    const { data: deleted, error: reqErr } = await supabase
      .from("requirements")
      .update({
        status: "COMPLETED",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (reqErr) return res.status(500).json({ error: reqErr.message });

    // 4. Record the status change in the audit trail
    if (current.status !== "COMPLETED") {
      await supabase.from("requirement_status_history").insert({
        requirement_id: id,
        old_status: current.status,
        new_status: "COMPLETED",
        changed_by: req.user.id,
      });
    }

    res.json({
      message: "Requirement and its tasks have been archived.",
      requirement: deleted,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Version history ─────────────────────────────────────────────────────────

export async function getVersions(req, res, next) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("requirement_versions")
      .select(
        "*, changed_by_user:profiles!requirement_versions_changed_by_fkey(id, full_name)",
      )
      .eq("requirement_id", id)
      .order("version_no", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ versions: data });
  } catch (err) {
    next(err);
  }
}

// ─── Status history (audit trail) ────────────────────────────────────────────

export async function getStatusHistory(req, res, next) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("requirement_status_history")
      .select(
        "*, changed_by_user:profiles!requirement_status_history_changed_by_fkey(id, full_name)",
      )
      .eq("requirement_id", id)
      .order("changed_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ history: data });
  } catch (err) {
    next(err);
  }
}

// ─── Specification CRUD ───────────────────────────────────────────────────────

// Specifications are the analytical output produced during UNDER_ANALYSIS and
// formalised in SPECIFICATION_DRAFTED. Creating or editing a spec only makes
// sense in these two states — not before analysis has started, and not after
// the requirement has been approved (which would bypass the review cycle).
const SPEC_ALLOWED_STATUSES = ["UNDER_ANALYSIS", "SPECIFICATION_DRAFTED"];

export async function createSpec(req, res, next) {
  try {
    const { id: requirement_id } = req.params;
    const {
      title,
      description,
      acceptance_criteria,
      complexity_score,
      status,
    } = req.body;

    // Verify the requirement exists and is in an analysis-phase state
    const { data: requirement, error: reqErr } = await supabase
      .from("requirements")
      .select("status")
      .eq("id", requirement_id)
      .single();

    if (reqErr || !requirement) {
      return res.status(404).json({ error: "Requirement not found." });
    }

    if (!SPEC_ALLOWED_STATUSES.includes(requirement.status)) {
      return res.status(400).json({
        error:
          `Specifications can only be created while the requirement is in ` +
          `UNDER_ANALYSIS or SPECIFICATION_DRAFTED. Current status: ${requirement.status}`,
      });
    }

    const { data, error } = await supabase
      .from("requirement_specifications")
      .insert({
        requirement_id,
        title,
        description,
        acceptance_criteria,
        complexity_score,
        status: status || "DRAFT",
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ spec: data });
  } catch (err) {
    next(err);
  }
}

export async function updateSpec(req, res, next) {
  try {
    const { id: requirement_id, spec_id } = req.params;
    const {
      title,
      description,
      acceptance_criteria,
      complexity_score,
      status,
    } = req.body;

    // Verify the requirement exists and is in an analysis-phase state
    const { data: requirement, error: reqErr } = await supabase
      .from("requirements")
      .select("status")
      .eq("id", requirement_id)
      .single();

    if (reqErr || !requirement) {
      return res.status(404).json({ error: "Requirement not found." });
    }

    if (!SPEC_ALLOWED_STATUSES.includes(requirement.status)) {
      return res.status(400).json({
        error:
          `Specifications can only be edited while the requirement is in ` +
          `UNDER_ANALYSIS or SPECIFICATION_DRAFTED. Current status: ${requirement.status}`,
      });
    }

    // Verify the spec actually belongs to this requirement (not just any spec_id)
    const { data: existingSpec, error: specFetchErr } = await supabase
      .from("requirement_specifications")
      .select("id")
      .eq("id", spec_id)
      .eq("requirement_id", requirement_id)
      .single();

    if (specFetchErr || !existingSpec) {
      return res.status(404).json({
        error: "Specification not found for this requirement.",
      });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (acceptance_criteria !== undefined)
      updates.acceptance_criteria = acceptance_criteria;
    if (complexity_score !== undefined)
      updates.complexity_score = complexity_score;
    if (status !== undefined) updates.status = status;

    const { data, error } = await supabase
      .from("requirement_specifications")
      .update(updates)
      .eq("id", spec_id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ spec: data });
  } catch (err) {
    next(err);
  }
}
