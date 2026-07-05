/**
 * src/controllers/authController.js
 *
 * Handles the server-side parts of authentication:
 *   - POST /api/auth/register  — creates a Supabase auth user AND the profile row
 *   - GET  /api/auth/me        — returns the current user's profile
 *   - POST /api/auth/team      — pm-only: creates a pm/member account
 *
 * Note: login/logout are handled entirely by the Supabase client SDK on the
 * frontend. The backend only needs register (to set the role in profiles) and
 * me (to verify the session and return enriched profile data).
 */

import supabase from "../config/supabase.js";
import { createAccount, generateTempPassword } from "../services/accountService.js";

/**
 * POST /api/auth/register
 * Body: { email, password, full_name }
 *
 * This endpoint only ever creates CLIENT accounts — role is hardcoded, not
 * read from the request body, so no input can influence it. pm/member
 * accounts are created via POST /api/auth/team (pm-only) or, for the very
 * first pm, scripts/manageAccount.js (see PROCESS_FLOW.md).
 */
export async function register(req, res, next) {
  try {
    const { email, password, full_name } = req.body;

    const user = await createAccount({ email, password, full_name, role: "client" });

    res.status(201).json({
      message: "User registered successfully.",
      user,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.message === "Failed to create user profile.") {
      return res.status(500).json({ error: err.message });
    }
    next(err);
  }
}

/**
 * POST /api/auth/team
 * Body: { email, full_name, role: "pm" | "member" }
 *
 * pm-only. Creates a pm or member account with a system-generated password
 * (there's no email/SMTP infrastructure in this project to invite users by
 * link, and having the PM choose another person's password is weaker
 * practice) — the password is returned once in the response and never
 * persisted anywhere beyond the Supabase Auth record itself.
 */
export async function createTeamMember(req, res, next) {
  try {
    const { email, full_name, role } = req.body;
    const password = generateTempPassword();

    const user = await createAccount({ email, password, full_name, role });

    res.status(201).json({ user, temporary_password: password });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.message === "Failed to create user profile.") {
      return res.status(500).json({ error: err.message });
    }
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

    if (error) return next(error);
    res.json({ users: data });
  } catch (err) {
    next(err);
  }
}
