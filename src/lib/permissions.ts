import { supabaseAdmin } from "./supabase.js";

/**
 * Throws if the given user isn't allowed to post in this conversation.
 * Covers channel and group admin-only posting. Membership is checked here as
 * well as by the text route so direct media-upload calls cannot bypass
 * conversation access.
 */
export async function assertCanPostInConversation(clerkUserId: string, conversationId: string) {
  const { data: conv } = await supabaseAdmin.from("conversations").select("type, only_admins_send").eq("id", conversationId).single();
  if (!conv) return; // let the caller's own insert fail with a clearer error if the conversation doesn't exist

  const { data: membership } = await supabaseAdmin.from("conversation_members").select("role").eq("conversation_id", conversationId).eq("clerk_user_id", clerkUserId).maybeSingle();
  if (!membership) throw new Error("You are not a member of this conversation");

  // Channels are announcement feeds. The shared conversation endpoints must
  // apply the same rule as /send-channel-post, otherwise a subscriber can
  // bypass the channel composer and publish directly through /send-message or
  // a media-upload endpoint.
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
