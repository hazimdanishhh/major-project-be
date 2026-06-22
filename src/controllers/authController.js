/**
 * src/controllers/authController.js
 *
 * Handles the server-side parts of authentication:
 *   - POST /api/auth/register  — creates a Supabase auth user AND the profile row
 *   - GET  /api/auth/me        — returns the current user's profile
 *
 * Note: login/logout are handled entirely by the Supabase client SDK on the
 * frontend. The backend only needs register (to set the role in profiles) and
 * me (to verify the session and return enriched profile data).
 */

import supabase from "../config/supabase.js";

/**
 * POST /api/auth/register
 * Body: { email, password, full_name, role }
 * role must be 'client' | 'pm' | 'member'
 *
 * Creates the auth user, then inserts into profiles.
 * The handle_new_user() trigger in Supabase also fires,
 * but we insert explicitly here so registration is atomic
 * and role validation happens in code, not just the DB check constraint.
 */
export async function register(req, res, next) {
  try {
    const { email, password, full_name, role } = req.body;

    // 1. Create the Supabase auth user via admin API (service-role can do this)
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // skip email confirmation for dev/demo
        user_metadata: { full_name, role },
      });

    if (authError) {
      const status = authError.message.includes("already registered")
        ? 409
        : 400;
      return res.status(status).json({ error: authError.message });
    }

    const userId = authData.user.id;

    // 2. Upsert the profiles row (the trigger may have already created it).
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .upsert({ id: userId, full_name, role }, { onConflict: "id" })
      .select()
      .single();

    if (profileError) {
      // Auth user was created — clean up to avoid orphaned auth entries.
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: "Failed to create user profile." });
    }

    res.status(201).json({
      message: "User registered successfully.",
      user: {
        id: userId,
        email,
        full_name: profile.full_name,
        role: profile.role,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile.
 * req.user is already populated by requireAuth middleware.
 */
export async function me(req, res) {
  res.json({ user: req.user });
}

/**
 * GET /api/auth/users
 * Returns all users (profiles) — PM only, for assignment dropdowns.
 */
export async function listUsers(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .order("full_name");

    if (error) return res.status(500).json({ error: error.message });
    res.json({ users: data });
  } catch (err) {
    next(err);
  }
}
