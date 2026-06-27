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
 */

import supabase from "../config/supabase.js";

// GET ALL PROJECTS
export async function listProjects(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select(
        `id, name, description, status, created_at,
         owner:profiles!projects_pm_id_fkey(id, full_name, role),
         client:profiles!projects_client_id_fkey(id, full_name, role)`,
      )
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ projects: data });
  } catch (err) {
    next(err);
  }
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

    // 4. Apply Search (searches name OR description)
    if (search) {
      query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
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

    if (error) return res.status(500).json({ error: error.message });

    // 8. Return exactly what usePaginatedQuery expects!
    res.json({
      data, // The array of projects
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

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ project: data });
  } catch (err) {
    next(err);
  }
}

// GET PROJECT BY ID
export async function getProject(req, res, next) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("projects")
      .select(
        `*, 
         owner:profiles!projects_pm_id_fkey(id, full_name, role),
         client:profiles!projects_client_id_fkey(id, full_name, role)`,
      )
      .eq("id", id)
      .single();

    if (error || !data)
      return res.status(404).json({ error: "Project not found." });
    res.json({ project: data });
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

    const { data, error } = await supabase
      .from("projects")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Project not found." });
    res.json({ project: data });
  } catch (err) {
    next(err);
  }
}

// DELETE (ARCHIVE) PROJECT BY ID
// Soft-delete: sets status to ARCHIVED (uppercase, matches project-status enum).
export async function deleteProject(req, res, next) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("projects")
      .update({ status: "ARCHIVED", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Project not found." });
    res.json({ message: "Project archived.", project: data });
  } catch (err) {
    next(err);
  }
}
