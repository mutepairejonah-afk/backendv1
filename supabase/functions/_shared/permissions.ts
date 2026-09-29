// Ported from src/lib/permissions.ts (Node backend). Logic is identical;
// only the supabaseAdmin import path changed. Kept here rather than shared
// with the Node app since there's no cross-runtime shared-code step in this
// project -- see the note atop _shared/ai.ts.
import { supabaseAdmin } from "./supabase-admin.ts";

export async function assertCanPostInConversation(clerkUserId: string, conversationId: string) {
  const { data: conv } = await supabaseAdmin.from("conversations").select("type, only_admins_send").eq("id", conversationId).single();
  if (!conv) return; // let the caller's own insert fail with a clearer error if the conversation doesn't exist

  const { data: membership } = await supabaseAdmin.from("conversation_members").select("role").eq("conversation_id", conversationId).eq("clerk_user_id", clerkUserId).maybeSingle();
  if (!membership) throw new Error("You are not a member of this conversation");

  if (conv.type === "channel") {
    const { data: channel } = await supabaseAdmin.from("channels").select("id").eq("conversation_id", conversationId).maybeSingle();
    if (channel) {
      const { data: channelMembership } = await supabaseAdmin.from("channel_members").select("role").eq("channel_id", channel.id).eq("clerk_user_id", clerkUserId).maybeSingle();
      if (channelMembership?.role !== "admin") throw new Error("Only channel admins can publish posts");
      return;
    }
  }

  if (conv.type === "group" && conv.only_admins_send) {
    if (membership.role !== "admin") throw new Error("Only admins can send messages in this group");
    return;
  }
}
