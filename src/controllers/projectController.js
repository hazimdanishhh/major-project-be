/**
 * src/controllers/projectController.js
 *
 * Routes:
 *   GET    /api/projects              — list all projects visible to the user
 *   POST   /api/projects              — create a project (pm only)
 *   GET    /api/projects/:id          — get a single project with stats
 *   PATCH  /api/projects/:id          — update project (pm only)
 *   DELETE /api/projects/:id          — soft-delete / archive (pm only)
 *   GET    /api/projects/:id/critical-path  — CPM analysis (see algorithmController)
 *
 * Visibility: pm sees projects where pm_id = them; client sees projects where
 * client_id = them; member sees projects where they're the assignee on at
 * least one task belonging to that project (tasks have no direct project_id
 * column — the path is tasks.requirement_id -> requirements.project_id).
 *
 * Every project returned by listProjectsPaginated/getProject carries a
 * `requirement_completion: {total, completed, percentage}` field (Phase 10),
 * computed via calculateProjectCompletion (algorithms.js) over that project's
 * requirements' statuses.
 */

import supabase from "../config/supabase.js";
import { getMemberVisibleProjectIds } from "../utils/projectAccess.js";
import { calculateProjectCompletion } from "../algorithms.js";

// Batch-fetches every requirement's status for the given project IDs in one
// query, groups them by project_id, and returns a Map<project_id,
// ReturnType<calculateProjectCompletion>> — used by both listProjectsPaginated
// and getProject so a project's completion % is computed identically in both.
async function getRequirementCompletionByProjectId(projectIds) {
  if (projectIds.length === 0) return new Map();

  const { data: requirements, error } = await supabase
    .from("requirements")
    .select("project_id, status")
    .in("project_id", projectIds);

  if (error) throw error;

  const byProject = new Map();
  for (const req of requirements || []) {
    if (!byProject.has(req.project_id)) byProject.set(req.project_id, []);
    byProject.get(req.project_id).push(req);
  }

  const completionByProject = new Map();
  for (const projectId of projectIds) {
    completionByProject.set(
      projectId,
      calculateProjectCompletion(byProject.get(projectId) || []),
    );
  }
  return completionByProject;
}

// Strips PostgREST .or() filter-syntax characters (`,`, `(`, `)`) from a
// search term before interpolating it into a raw filter string — otherwise
// a crafted value could alter the filter's boolean structure.
function sanitizeSearchTerm(term) {
  return term.replace(/[,()]/g, "");
}

// GET ALL PROJECTS (Paginated, Searchable, Filtered)
export async function listProjectsPaginated(req, res, next) {
  try {
    // 1. Extract the query parameters sent by the frontend
    const {
      page = 1,
      pageSize = 20,
      search,
      sortBy = "created_at",
      sortOrder = "descending",
      ...filters // Any remaining parameters (like status=ACTIVE) are captured here
    } = req.query;

    // 2. Calculate Supabase range for pagination
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    // 3. Initialize the base query
    let query = supabase.from("projects").select(
      `id, name, description, status, created_at,
         owner:profiles!projects_pm_id_fkey(id, full_name, role),
         client:profiles!projects_client_id_fkey(id, full_name, role)`,
      { count: "exact" },
    );

    // 3b. Role-based scoping — applied before search/filters/sort so it's an
    // unconditional AND regardless of what the caller passes in the querystring.
    if (req.user.role === "pm") {
      query = query.eq("pm_id", req.user.id);
    } else if (req.user.role === "client") {
      query = query.eq("client_id", req.user.id);
    } else if (req.user.role === "member") {
      const projectIds = await getMemberVisibleProjectIds(req.user.id);
      if (projectIds.length === 0) return res.json({ data: [], totalCount: 0 });
      query = query.in("id", projectIds);
    } else {
      return res.status(403).json({ error: "Access denied." });
    }

    // 4. Apply Search (searches name OR description)
    if (search) {
      const safeSearch = sanitizeSearchTerm(search);
      query = query.or(
        `name.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%`,
      );
    }

    // 5. Apply Dynamic Filters (e.g., ?status=ACTIVE or ?client_id=123)
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        query = query.eq(key, value);
      }
    });

    // 6. Apply Sorting and Pagination
    query = query
      .order(sortBy, { ascending: sortOrder === "ascending" })
      .range(from, to);

    // 7. Execute the query
    const { data, count, error } = await query;

    if (error) return next(error);

    // 7b. Attach each project's requirement-completion percentage (Phase 10)
    const completionByProject = await getRequirementCompletionByProjectId(
      (data || []).map((p) => p.id),
    );
    const dataWithCompletion = (data || []).map((p) => ({
      ...p,
      requirement_completion: completionByProject.get(p.id),
    }));

    // 8. Return exactly what usePaginatedQuery expects!
    res.json({
      data: dataWithCompletion, // The array of projects
      totalCount: count, // The exact count for pagination math
    });
  } catch (err) {
    next(err);
  }
}

// CREATE NEW PROJECT
export async function createProject(req, res, next) {
  try {
    const { name, description, client_id } = req.body;

    const { data, error } = await supabase
      .from("projects")
      .insert({
        name,
        description,
        pm_id: req.user.id,
        client_id,
        status: "ACTIVE",
      })
      .select()
      .single();

    if (error) return next(error);
    res.status(201).json({ project: data });
  } catch (err) {
    next(err);
  }
}

// GET PROJECT BY ID
export async function getProject(req, res, next) {
  try {
    const { id } = req.params;

    let query = supabase
      .from("projects")
      .select(
        `*,
         owner:profiles!projects_pm_id_fkey(id, full_name, role),
         client:profiles!projects_client_id_fkey(id, full_name, role)`,
      )
      .eq("id", id);

    if (req.user.role === "pm") {
      query = query.eq("pm_id", req.user.id);
    } else if (req.user.role === "client") {
      query = query.eq("client_id", req.user.id);
    }
    // "member" can't be expressed as a simple .eq() here (no direct FK) —
    // handled with a post-fetch check below.

    const { data, error } = await query.single();

    if (error || !data)
      return res.status(404).json({ error: "Project not found." });

    if (req.user.role === "member") {
      const projectIds = await getMemberVisibleProjectIds(req.user.id);
      if (!projectIds.includes(id)) {
        return res.status(404).json({ error: "Project not found." });
      }
    }

    // Attach the project's requirement-completion percentage (Phase 10)
    const completionByProject = await getRequirementCompletionByProjectId([id]);

    res.json({
      project: { ...data, requirement_completion: completionByProject.get(id) },
    });
  } catch (err) {
    next(err);
  }
}

// UPDATE PROJECT BY ID
export async function updateProject(req, res, next) {
  try {
    const { id } = req.params;
    const { name, description, status, client_id } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;
    if (client_id !== undefined) updates.client_id = client_id;
    updates.updated_at = new Date().toISOString();

    // Only the owning pm may update a project — matches getProject's scoping.
    // Not using .single() here: with the pm_id filter added, a wrong-owner
    // update matches zero rows just like a nonexistent id would, and
    // .single() treats "zero rows" as a query error rather than empty data.
    const { data, error } = await supabase
      .from("projects")
      .update(updates)
      .eq("id", id)
      .eq("pm_id", req.user.id)
      .select();

    if (error) return next(error);
    if (!data || data.length === 0)
      return res.status(404).json({ error: "Project not found." });
    res.json({ project: data[0] });
  } catch (err) {
    next(err);
  }
}

// DELETE (ARCHIVE) PROJECT BY ID
// Soft-delete: sets status to ARCHIVED (uppercase, matches project-status enum).
export async function deleteProject(req, res, next) {
  try {
    const { id } = req.params;

    // Only the owning pm may archive a project — matches getProject's scoping.
    // Not using .single() here for the same reason as updateProject above.
    const { data, error } = await supabase
      .from("projects")
      .update({ status: "ARCHIVED", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("pm_id", req.user.id)
      .select();

    if (error) return next(error);
    if (!data || data.length === 0)
      return res.status(404).json({ error: "Project not found." });
    res.json({ message: "Project archived.", project: data[0] });
  } catch (err) {
    next(err);
  }
}
