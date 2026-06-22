/**
 * src/middleware/auth.js
 *
 * requireAuth  — Validates the Supabase JWT from the Authorization header.
 *                Attaches { id, email, role, full_name } to req.user.
 *
 * requireRole  — Factory that returns a middleware which checks req.user.role
 *                against an allowed list. Must be used AFTER requireAuth.
 *
 * Usage:
 *   router.get('/my-route', requireAuth, requireRole('pm', 'member'), handler)
 */

import supabase from "../config/supabase.js";

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or malformed Authorization header." });
  }

  const token = authHeader.replace("Bearer ", "");

  // Verify the JWT with Supabase Auth.
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }

  // Fetch the user's role from the profiles table.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", data.user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({
      error: "User profile not found. Please complete registration.",
    });
  }

  req.user = {
    id: data.user.id,
    email: data.user.email,
    role: profile.role,
    full_name: profile.full_name,
  };

  next();
}

/**
 * @param {...string} roles  - e.g. requireRole('pm', 'member')
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required." });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(", ")}. Your role: ${req.user.role}.`,
      });
    }

    next();
  };
}
