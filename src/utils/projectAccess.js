/**
 * src/utils/projectAccess.js
 *
 * Shared tenant-isolation helpers. A project is visible to: the pm who owns
 * it (pm_id), the client it was created for (client_id), or a member who has
 * been added to that project's team (project_members). Requirements and
 * tasks have no direct project_id/owner column of their own — their
 * visibility is always derived by walking back to the parent project via
 * tasks.requirement_id -> requirements.project_id -> projects.{pm_id,client_id}.
 *
 * Used by projectController.js, requirementController.js, taskController.js,
 * and aiController.js so every resource is scoped the same way.
 */

import supabase from "../config/supabase.js";

// Projects visible to a `member`: any project they've been added to via
// project_members. This is also the sole source of truth for who a task can
// be assigned to (see isProjectMember below) — a member's project visibility
// and their assignability are deliberately the same set, so removing someone
// from a project's team also revokes their view of it.
export async function getMemberVisibleProjectIds(memberId) {
  const { data, error } = await supabase
    .from("project_members")
    .select("project_id")
    .eq("member_id", memberId);
  if (error) throw error;

  return [...new Set((data || []).map((r) => r.project_id).filter(Boolean))];
}

// Whether `profileId` (a member or pm) is on `projectId`'s team, per
// project_members. Used to gate task assignment (createTask/updateTask,
// persistWBS) so a task can only be assigned to someone actually on the
// project — Supervisor Note #2.
export async function isProjectMember(projectId, profileId) {
  if (!projectId || !profileId) return false;

  const { data, error } = await supabase
    .from("project_members")
    .select("id")
    .eq("project_id", projectId)
    .eq("member_id", profileId)
    .maybeSingle();
  if (error) throw error;

  return !!data;
}

/**
 * Resolves the set of project IDs the caller is allowed to see/act on,
 * based on their role: pm -> owned projects, client -> their projects,
 * member -> projects containing a task assigned to them.
 */
export async function getVisibleProjectIds(user) {
  if (user.role === "pm") {
    const { data, error } = await supabase
      .from("projects")
      .select("id")
      .eq("pm_id", user.id);
    if (error) throw error;
    return (data || []).map((p) => p.id);
  }

  if (user.role === "client") {
    const { data, error } = await supabase
      .from("projects")
      .select("id")
      .eq("client_id", user.id);
    if (error) throw error;
    return (data || []).map((p) => p.id);
  }

  if (user.role === "member") {
    return getMemberVisibleProjectIds(user.id);
  }

  return [];
}

/**
 * Resolves the set of requirement IDs that belong to a project the caller
 * can see. Used to scope task queries, since tasks only carry
 * requirement_id, not project_id.
 */
export async function getVisibleRequirementIds(user) {
  const visibleProjectIds = await getVisibleProjectIds(user);
  if (visibleProjectIds.length === 0) return [];

  const { data, error } = await supabase
    .from("requirements")
    .select("id")
    .in("project_id", visibleProjectIds);
  if (error) throw error;

  return (data || []).map((r) => r.id);
}
