/**
 * src/config/supabase.js
 *
 * Creates a single Supabase client using the service-role key.
 * This client has full DB access and bypasses RLS — it must NEVER
 * be exposed to the browser. All authorization decisions are handled
 * in middleware/auth.js before any route handler runs.
 */

import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables.",
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      // The service-role client should not persist sessions or auto-refresh.
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  },
);

export default supabase;
