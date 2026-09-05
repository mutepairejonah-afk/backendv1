import { supabaseAdmin } from "./supabase.js";

/**
 * Throws if the given user isn't allowed to post in this conversation.
 * Covers two "admin-only posting" cases:
 *   - a group with `only_admins_send` enabled (existing feature)
 *   - a channel with `is_broadcast` enabled (Telegram-style channel: only
 *     channel admins post, everyone else can only read)
 */
export async function assertCanPostInConversation(clerkUserId: string, conversationId: string) {
  const { data: conv } = await supabaseAdmin.from("conversations").select("type, only_admins_send").eq("id", conversationId).single();
  if (!conv) return; // let the caller's own insert fail with a clearer error if the conversation doesn't exist

  if (conv.type === "group" && conv.only_admins_send) {
    const { data: m } = await supabaseAdmin.from("conversation_members").select("role").eq("conversation_id", conversationId).eq("clerk_user_id", clerkUserId).maybeSingle();
    if (!m || m.role !== "admin") throw new Error("Only admins can send messages in this group");
    return;
  }

  if (conv.type === "channel") {
    const { data: channel } = await supabaseAdmin.from("channels").select("id, is_broadcast").eq("conversation_id", conversationId).maybeSingle();
    if (channel?.is_broadcast) {
      const { data: m } = await supabaseAdmin.from("channel_members").select("role").eq("channel_id", channel.id).eq("clerk_user_id", clerkUserId).maybeSingle();
      if (!m || m.role !== "admin") throw new Error("This is a broadcast channel — only admins can post here");
    }
  }
}
