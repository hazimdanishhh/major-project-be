/**
 * src/services/accountService.js
 *
 * Shared account-creation logic used by three call sites: the public
 * register endpoint (role hardcoded to "client"), the pm-only Team
 * endpoint (role chosen by the caller), and scripts/manageAccount.js
 * (run directly against the database, no HTTP involved). Centralising
 * this avoids drifting duplicate copies of the create-user + profile-row
 * + rollback-on-failure sequence.
 */

import crypto from "crypto";
import supabase from "../config/supabase.js";

/**
 * Creates a Supabase auth user and its profiles row for the given role.
 * Throws an Error with a `.status` (409 for duplicate email, 400 otherwise)
 * if the auth user can't be created, or a generic Error if the profile
 * insert fails (in which case the orphaned auth user is rolled back).
 */
export async function createAccount({ email, password, full_name, role }) {
  const { data: authData, error: authError } =
    await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // skip email confirmation for dev/demo — no SMTP is configured
      user_metadata: { full_name, role },
    });

  if (authError) {
    // Supabase's exact wording has changed before ("already registered" vs
    // "has already been registered") — match loosely on both keywords
    // rather than an exact phrase so this doesn't silently break again.
    const lower = authError.message.toLowerCase();
    const isDuplicate = lower.includes("already") && lower.includes("regist");
    const err = new Error(authError.message);
    err.status = isDuplicate ? 409 : 400;
    throw err;
  }

  const userId = authData.user.id;

  // Upsert the profiles row (the handle_new_user() trigger may have already
  // created it with a default role — this overwrites it with the intended one).
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .upsert({ id: userId, full_name, role }, { onConflict: "id" })
    .select()
    .single();

  if (profileError) {
    // Auth user was created — clean up to avoid orphaned auth entries.
    await supabase.auth.admin.deleteUser(userId);
    throw new Error("Failed to create user profile.");
  }

  return { id: userId, email, full_name: profile.full_name, role: profile.role };
}

/**
 * Generates a random password guaranteed to satisfy the app's password
 * policy (10-72 chars, at least one upper/lower/digit/special character)
 * without needing the caller to think one up — used by the Team endpoint
 * and the CLI script's `create` command.
 */
export function generateTempPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%^&*-_=+";
  const all = upper + lower + digits + special;

  const pick = (chars) => chars[crypto.randomInt(chars.length)];

  const required = [pick(upper), pick(lower), pick(digits), pick(special)];
  const fill = Array.from({ length: 8 }, () => pick(all));
  const chars = [...required, ...fill];

  // Fisher-Yates shuffle so the required chars aren't always in the same spot.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}
