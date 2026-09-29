import { supabaseAdmin } from "./supabase-admin.ts";

/**
 * Same call shape as src/lib/rate-limit.ts's checkRateLimit, but backed by
 * Postgres (via the check_rate_limit RPC -- see
 * supabase/migrations/20260920000000_add_api_rate_limit_table.sql) instead of
 * an in-memory Map, since Edge Function isolates don't share memory across
 * invocations the way a single long-lived Node process does.
 */
export async function checkRateLimit(key: string, maxReqs: number, windowMs: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
    p_key: key,
    p_max_reqs: maxReqs,
    p_window_ms: windowMs,
  });
  if (error) {
    // Fail open on infra errors rather than locking everyone out because the
    // rate-limit table had a hiccup -- matches the Node lib's spirit of
    // "rate limiting is a courtesy, not the security boundary".
    console.error("[rate-limit] check_rate_limit RPC failed, allowing through:", error.message);
    return true;
  }
  return data === true;
}
