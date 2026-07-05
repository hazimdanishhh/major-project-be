/**
 * scripts/manageAccount.js
 *
 * Standalone recovery/bootstrap tool — talks to Supabase directly via the
 * service-role key already in .env, independent of any existing account,
 * the app's HTTP server, or the frontend. This is deliberately NOT an HTTP
 * endpoint: "create a pm account" over the network (even gated on "no pm
 * exists yet") is a public race-condition window, whereas running this
 * script requires the same server/.env access the service-role key itself
 * already assumes as its trust boundary.
 *
 * Because there's no email/SMTP infrastructure in this project, this is
 * also the durable answer to "how do we always have a way to create the
 * first PM": as long as you have the repo and .env, `create` works,
 * unconditionally, regardless of what accounts already exist.
 *
 * Usage:
 *   node scripts/manageAccount.js create --email=pm@x.com --password=Xyz123!@# --full_name="Jane PM" --role=pm
 *   node scripts/manageAccount.js reset-password --email=pm@x.com --password=NewPass123!
 */

import "dotenv/config";
import supabase from "../src/config/supabase.js";
import { createAccount } from "../src/services/accountService.js";

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) flags[match[1]] = match[2];
  }
  return flags;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function runCreate(flags) {
  const { email, password, full_name, role } = flags;
  if (!email || !password || !full_name || !role) {
    fail(
      "create requires --email, --password, --full_name, and --role (client|pm|member)",
    );
  }
  if (!["client", "pm", "member"].includes(role)) {
    fail(`--role must be one of client, pm, member (got "${role}")`);
  }

  const user = await createAccount({ email, password, full_name, role });
  console.log(`Created ${user.role} account for ${user.email} (id: ${user.id})`);
}

async function runResetPassword(flags) {
  const { email, password } = flags;
  if (!email || !password) {
    fail("reset-password requires --email and --password");
  }

  // The admin API in this supabase-js version has no "get user by email"
  // lookup, so page through listUsers() and match manually. A perPage of
  // 1000 comfortably covers this project's test/dummy account volumes.
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) fail(error.message);

  const match = data.users.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!match) fail(`No user found with email ${email}`);

  const { error: updateError } = await supabase.auth.admin.updateUserById(
    match.id,
    { password },
  );
  if (updateError) fail(updateError.message);

  console.log(`Password reset for ${email} (id: ${match.id})`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (command === "create") {
    await runCreate(flags);
  } else if (command === "reset-password") {
    await runResetPassword(flags);
  } else {
    fail(
      'unknown command — use "create" or "reset-password". See the file header for usage.',
    );
  }
}

main().catch((err) => fail(err.message));
