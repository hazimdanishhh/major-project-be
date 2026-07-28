/**
 * src/controllers/projectMemberController.js
 *
 * Routes:
 *   GET    /api/projects/:id/members             — list a project's team
 *   POST   /api/projects/:id/members              — add a member (pm, owner only)
 *   DELETE /api/projects/:id/members/:memberId    — remove a member (pm, owner only)
 *
 * project_members is the source of truth for which profiles can be assigned
 * a task on a given project (enforced in taskController.js/aiController.js)
 * and, via getMemberVisibleProjectIds (projectAccess.js), for which projects
 * a `member` can see at all. Only `member`/`pm` profiles may be added —
 * `client` is rejected here in application code, since a cross-table role
 * CHECK isn't expressible as a plain Postgres constraint without a trigger.
 */

import supabase from "../config/supabase.js";
import { getVisibleProjectIds } from "../utils/projectAccess.js";

// ─── List ────────────────────────────────────────────────────────────────────

export async function listProjectMembers(req, res, next) {
  try {
    const { id: projectId } = req.params;

    const visibleProjectIds = await getVisibleProjectIds(req.user);
    if (!visibleProjectIds.includes(projectId)) {
      return res.status(404).json({ error: "Project not found." });
    }

    const { data, error } = await supabase
      .from("project_members")
      .select(
        "id, project_id, member_id, created_at, member:profiles!project_members_member_id_fkey(id, full_name, role)",
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (error) return next(error);
    res.json({ members: data });
  } catch (err) {
    next(err);
  }
}

// ─── Add ─────────────────────────────────────────────────────────────────────

export async function addProjectMember(req, res, next) {
  try {
    const { id: projectId } = req.params;
    const { member_id } = req.body;

    // Only the owning pm may manage their own project's team — role gate
    // alone isn't enough, mirrors updateProject/deleteProject's ownership check.
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("pm_id", req.user.id)
      .single();

    if (projErr || !project) {
      return res.status(404).json({ error: "Project not found." });
    }

    const { data: targetProfile, error: profileErr } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", member_id)
      .single();

    if (profileErr || !targetProfile) {
      return res.status(404).json({ error: "User not found." });
    }

    if (targetProfile.role === "client") {
      return res.status(400).json({
        error: "A client cannot be added as a project member.",
      });
    }

    const { data, error } = await supabase
      .from("project_members")
      .insert({ project_id: projectId, member_id, added_by: req.user.id })
      .select(
        "id, project_id, member_id, created_at, member:profiles!project_members_member_id_fkey(id, full_name, role)",
      )
      .single();

    if (error) {
      if (error.code === "23505") {
        return res
          .status(409)
          .json({ error: "This user is already a project member." });
      }
      return next(error);
    }

    res.status(201).json({ member: data });
  } catch (err) {
    next(err);
  }
}

// ─── Remove ──────────────────────────────────────────────────────────────────

export async function removeProjectMember(req, res, next) {
  try {
    const { id: projectId, memberId } = req.params;

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("pm_id", req.user.id)
      .single();

    if (projErr || !project) {
      return res.status(404).json({ error: "Project not found." });
    }

    const { data, error } = await supabase
      .from("project_members")
      .delete()
      .eq("project_id", projectId)
      .eq("member_id", memberId)
      .select();

    if (error) return next(error);
    if (!data || data.length === 0) {
      return res.status(404).json({ error: "Project member not found." });
    }

    res.json({ message: "Project member removed." });
  } catch (err) {
    next(err);
  }
}
