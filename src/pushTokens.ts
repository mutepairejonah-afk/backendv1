import { supabaseAdmin } from "./lib/supabase.js";

/** Register (or refresh) a push token for a user. Supports multiple devices per user. */
export async function savePushToken(clerkUserId: string, token: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("push_tokens")
    .upsert(
      { clerk_user_id: clerkUserId, token, updated_at: new Date().toISOString() },
      { onConflict: "token" }
    );
  if (error) console.error("[push] failed to save token:", error.message);
}

/** All tokens currently registered for a user (may be more than one device). */
export async function getPushTokensForUser(clerkUserId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("push_tokens")
    .select("token")
    .eq("clerk_user_id", clerkUserId);
  if (error) {
    console.error("[push] failed to load tokens:", error.message);
    return [];
  }
  return (data || []).map((r) => r.token);
}

/** Batched version of getPushTokensForUser for notifying several users at once (e.g. a group message) -- one query instead of one per user. */
export async function getPushTokensForUsers(clerkUserIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!clerkUserIds.length) return result;
  const { data, error } = await supabaseAdmin
    .from("push_tokens")
    .select("clerk_user_id, token")
    .in("clerk_user_id", clerkUserIds);
  if (error) {
    console.error("[push] failed to load tokens:", error.message);
    return result;
  }
  for (const row of data || []) {
    const list = result.get(row.clerk_user_id) || [];
    list.push(row.token);
    result.set(row.clerk_user_id, list);
  }
  return result;
}

/** Drop a token once Expo reports it as invalid/unregistered, so it stops being retried forever. */
export async function deletePushToken(token: string): Promise<void> {
  const { error } = await supabaseAdmin.from("push_tokens").delete().eq("token", token);
  if (error) console.error("[push] failed to delete token:", error.message);
}
