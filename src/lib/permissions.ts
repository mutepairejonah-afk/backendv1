import { supabaseAdmin } from "./supabase.js";

/**
 * Throws if the given user isn't allowed to post in this conversation.
 * Covers group admin-only posting while allowing every current channel member
 * to post text and media. Membership is checked here as well as by the text
 * route so direct media-upload calls cannot bypass conversation access.
 */
export async function assertCanPostInConversation(clerkUserId: string, conversationId: string) {
  const { data: conv } = await supabaseAdmin.from("conversations").select("type, only_admins_send").eq("id", conversationId).single();
  if (!conv) return; // let the caller's own insert fail with a clearer error if the conversation doesn't exist

  const { data: membership } = await supabaseAdmin.from("conversation_members").select("role").eq("conversation_id", conversationId).eq("clerk_user_id", clerkUserId).maybeSingle();
  if (!membership) throw new Error("You are not a member of this conversation");

  if (conv.type === "group" && conv.only_admins_send) {
    if (membership.role !== "admin") throw new Error("Only admins can send messages in this group");
    return;
  }

}
