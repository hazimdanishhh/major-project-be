/**
 * src/utils/projectAccess.js
 *
 * Shared tenant-isolation helpers. A project is visible to: the pm who owns
 * it (pm_id), the client it was created for (client_id), or a member who is
 * the assignee on at least one task belonging to it. Requirements and tasks
 * have no direct project_id/owner column of their own — their visibility is
 * always derived by walking back to the parent project via
 * tasks.requirement_id -> requirements.project_id -> projects.{pm_id,client_id}.
 *
 * Used by projectController.js, requirementController.js, and
 * taskController.js so every resource is scoped the same way.
 */

import supabase from "../config/supabase.js";

// Projects visible to a `member`: any project containing a task assigned to them.
export async function getMemberVisibleProjectIds(memberId) {
  const { data: assignedTasks, error: taskErr } = await supabase
    .from("tasks")
    .select("requirement_id")
    .eq("assignee_id", memberId);
  if (taskErr) throw taskErr;

  const reqIds = [
    ...new Set((assignedTasks || []).map((t) => t.requirement_id).filter(Boolean)),
  ];
  if (reqIds.length === 0) return [];

  const { data: reqs, error: reqErr } = await supabase
    .from("requirements")
    .select("project_id")
    .in("id", reqIds);
  if (reqErr) throw reqErr;

  return [...new Set((reqs || []).map((r) => r.project_id).filter(Boolean))];
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
