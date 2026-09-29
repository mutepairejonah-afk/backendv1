import { createClient } from "npm:@supabase/supabase-js@^2";

// Service-role key: full DB access, same as src/lib/supabase.ts on the Node
// side. Edge Functions run server-side only, so this is safe here exactly
// the way it's safe in the Node backend -- never send this key to a client.
export const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
