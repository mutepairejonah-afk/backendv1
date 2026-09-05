import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { assertCanPostInConversation } from "../lib/permissions.js";

export const messagesRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

async function assertGroupAdmin(clerkUserId: string, conversationId: string) {
  const { data: conv } = await supabaseAdmin.from("conversations").select("*").eq("id", conversationId).single();
  if (!conv || conv.type !== "group") throw new Error("Not a group conversation");
  const { data: m } = await supabaseAdmin.from("conversation_members").select("role").eq("conversation_id", conversationId).eq("clerk_user_id", clerkUserId).maybeSingle();
  if (!m) throw new Error("You are not a member of this group");
  if (m.role !== "admin") throw new Error("Only admins can perform this action");
  return conv;
}

messagesRouter.post("/get-messages", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), limit: z.number().min(1).max(200).optional() }).parse(req.body);
  try {
    await supabaseAdmin.from("messages").delete().eq("conversation_id", data.conversationId).lt("expires_at", new Date().toISOString());
  } catch (err) { console.error("Expired-message sweep failed:", err); }

  // "Clear chat" — this member wiped history before a point in time; only
  // show messages sent after that, same as WhatsApp.
  const { data: membership } = await supabaseAdmin.from("conversation_members").select("cleared_at").eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId).maybeSingle();

  let query = supabaseAdmin.from("messages").select("*, reactions:message_reactions(*)").eq("conversation_id", data.conversationId).order("created_at", { ascending: true }).limit(data.limit || 100);
  if (membership?.cleared_at) query = query.gt("created_at", membership.cleared_at);
  const { data: messages, error } = await query;
  if (error) throw new Error(`Failed to get messages: ${error.message}`);
  if (!messages?.length) return [];

  // "Delete for me" — hide individually-deleted messages from this user only;
  // everyone else in the conversation still sees them normally.
  const msgIds = messages.map((m: any) => m.id);
  const { data: myDeletions } = await supabaseAdmin.from("message_deletions").select("message_id").eq("clerk_user_id", data.clerkUserId).in("message_id", msgIds);
  const deletedForMe = new Set((myDeletions || []).map((d: any) => d.message_id));
  const visibleMessages = messages.filter((m: any) => !deletedForMe.has(m.id));
  if (!visibleMessages.length) return [];
  const { data: stars } = await supabaseAdmin.from("starred_messages").select("message_id").eq("clerk_user_id", data.clerkUserId).in("message_id", msgIds);
  const starSet = new Set((stars || []).map((s: any) => s.message_id));
  return visibleMessages.map((m: any) => ({ ...m, starred_by_me: starSet.has(m.id) }));
}));

messagesRouter.post("/send-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), text: z.string().min(1).max(5000).optional(), imageUrl: z.string().url().max(2048).optional(), replyToMessageId: z.string().uuid().optional() }).parse(req.body);
  await assertCanPostInConversation(data.clerkUserId, data.conversationId);
  const { data: convPerm } = await supabaseAdmin.from("conversations").select("type, only_admins_send, disappearing_seconds").eq("id", data.conversationId).single();
  const expiresAt = convPerm?.disappearing_seconds ? new Date(Date.now() + convPerm.disappearing_seconds * 1000).toISOString() : null;
  const { data: message, error } = await supabaseAdmin.from("messages").insert({ conversation_id: data.conversationId, sender_clerk_id: data.clerkUserId, text: data.text || null, image_url: data.imageUrl || null, reply_to_message_id: data.replyToMessageId || null, expires_at: expiresAt }).select().single();
  if (error) throw new Error(`Failed to send message: ${error.message}`);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  const { data: members } = await supabaseAdmin.from("conversation_members").select("id, unread_count").eq("conversation_id", data.conversationId).neq("clerk_user_id", data.clerkUserId);
  if (members?.length) {
    for (const m of members) await supabaseAdmin.from("conversation_members").update({ unread_count: ((m as any).unread_count || 0) + 1 }).eq("id", (m as any).id);
  }
  return message;
}));

messagesRouter.post("/edit-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), messageId: z.string().uuid(), newText: z.string().min(1).max(5000) }).parse(req.body);
  const { data: msg } = await supabaseAdmin.from("messages").select("sender_clerk_id").eq("id", data.messageId).single();
  if (!msg) throw new Error("Message not found");
  if (msg.sender_clerk_id !== data.clerkUserId) throw new Error("You can only edit your own messages");
  const { data: updated, error } = await supabaseAdmin.from("messages").update({ text: data.newText, is_edited: true, edited_at: new Date().toISOString() }).eq("id", data.messageId).select().single();
  if (error) throw new Error(`Failed to edit message: ${error.message}`);
  return updated;
}));

messagesRouter.post("/delete-message-for-everyone", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), messageId: z.string().uuid() }).parse(req.body);
  const { data: msg } = await supabaseAdmin.from("messages").select("sender_clerk_id").eq("id", data.messageId).single();
  if (!msg) throw new Error("Message not found");
  if (msg.sender_clerk_id !== data.clerkUserId) throw new Error("You can only delete your own messages");
  const { error } = await supabaseAdmin.from("messages").update({ is_deleted: true, deleted_at: new Date().toISOString(), text: null, image_url: null, video_url: null, audio_url: null }).eq("id", data.messageId);
  if (error) throw new Error(`Failed to delete message: ${error.message}`);
  return { success: true };
}));

// ── Delete for me only (WhatsApp-style) ─────────────────────────────────────
// Hides a single message from this user's view without touching it for
// anyone else in the conversation, and without requiring the caller to be
// the sender (unlike delete-for-everyone). Persisted server-side so it stays
// hidden across devices and app reinstalls, not just on-device state.
messagesRouter.post("/delete-message-for-me", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), messageId: z.string().uuid() }).parse(req.body);
  const { data: msg } = await supabaseAdmin.from("messages").select("id, conversation_id").eq("id", data.messageId).maybeSingle();
  if (!msg) throw new Error("Message not found");
  const { data: membership } = await supabaseAdmin.from("conversation_members").select("id").eq("conversation_id", msg.conversation_id).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  if (!membership) throw new Error("You are not a member of this conversation");
  const { error } = await supabaseAdmin.from("message_deletions").upsert({ message_id: data.messageId, clerk_user_id: data.clerkUserId }, { onConflict: "message_id,clerk_user_id" });
  if (error) throw new Error(`Failed to delete message: ${error.message}`);
  return { success: true };
}));

messagesRouter.post("/add-reaction", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), messageId: z.string().uuid(), emoji: z.string().min(1).max(10) }).parse(req.body);
  const { data: existing } = await supabaseAdmin.from("message_reactions").select("id").eq("message_id", data.messageId).eq("clerk_user_id", data.clerkUserId).eq("emoji", data.emoji).single();
  if (existing) { await supabaseAdmin.from("message_reactions").delete().eq("id", existing.id); return { action: "removed" as const }; }
  await supabaseAdmin.from("message_reactions").insert({ message_id: data.messageId, clerk_user_id: data.clerkUserId, emoji: data.emoji });
  return { action: "added" as const };
}));

messagesRouter.post("/mark-messages-read", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), messageIds: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body);
  const rows = data.messageIds.map((msgId) => ({ message_id: msgId, clerk_user_id: data.clerkUserId }));
  await supabaseAdmin.from("message_read_receipts").upsert(rows, { onConflict: "message_id,clerk_user_id" });
  return { success: true };
}));

messagesRouter.post("/get-read-receipts", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ messageIds: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body);
  const { data: receipts } = await supabaseAdmin.from("message_read_receipts").select("message_id, clerk_user_id").in("message_id", data.messageIds);
  return receipts || [];
}));

messagesRouter.post("/toggle-pin-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), messageId: z.string().uuid() }).parse(req.body);
  const { data: msg } = await supabaseAdmin.from("messages").select("id, conversation_id, pinned").eq("id", data.messageId).single();
  if (!msg) throw new Error("Message not found");
  const { data: conv } = await supabaseAdmin.from("conversations").select("type").eq("id", msg.conversation_id).single();
  if (!conv) throw new Error("Conversation not found");
  if (conv.type === "group") { await assertGroupAdmin(data.clerkUserId, msg.conversation_id); }
  else {
    const { data: m } = await supabaseAdmin.from("conversation_members").select("id").eq("conversation_id", msg.conversation_id).eq("clerk_user_id", data.clerkUserId).maybeSingle();
    if (!m) throw new Error("You are not a member of this conversation");
  }
  const newPinned = !msg.pinned;
  await supabaseAdmin.from("messages").update({ pinned: newPinned, pinned_at: newPinned ? new Date().toISOString() : null, pinned_by: newPinned ? data.clerkUserId : null }).eq("id", data.messageId);
  return { pinned: newPinned };
}));

messagesRouter.post("/get-pinned-messages", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ conversationId: z.string().uuid() }).parse(req.body);
  const { data: msgs } = await supabaseAdmin.from("messages").select("*").eq("conversation_id", data.conversationId).eq("pinned", true).order("pinned_at", { ascending: false });
  return msgs || [];
}));

messagesRouter.post("/toggle-star-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), messageId: z.string().uuid() }).parse(req.body);
  const { data: existing } = await supabaseAdmin.from("starred_messages").select("id").eq("message_id", data.messageId).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  if (existing) { await supabaseAdmin.from("starred_messages").delete().eq("id", existing.id); return { starred: false }; }
  await supabaseAdmin.from("starred_messages").insert({ message_id: data.messageId, clerk_user_id: data.clerkUserId });
  return { starred: true };
}));

messagesRouter.post("/get-starred-messages", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: starred } = await supabaseAdmin.from("starred_messages").select("message_id, starred_at").eq("clerk_user_id", data.clerkUserId).order("starred_at", { ascending: false }).limit(200);
  if (!starred?.length) return [];
  const msgIds = starred.map((s: any) => s.message_id);
  const { data: msgs } = await supabaseAdmin.from("messages").select("*").in("id", msgIds);
  if (!msgs?.length) return [];
  const convIds = [...new Set(msgs.map((m: any) => m.conversation_id))];
  const { data: convs } = await supabaseAdmin.from("conversations").select("id, name, type, avatar_url").in("id", convIds);
  const senderIds = [...new Set(msgs.map((m: any) => m.sender_clerk_id))];
  const { data: profs } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, avatar_url").in("clerk_user_id", senderIds);
  return starred.map((s: any) => {
    const m = msgs.find((x: any) => x.id === s.message_id);
    if (!m) return null;
    return { ...m, starred_at: s.starred_at, conversation: convs?.find((c: any) => c.id === m.conversation_id) || null, sender: profs?.find((p: any) => p.clerk_user_id === m.sender_clerk_id) || null };
  }).filter(Boolean);
}));

// Polls
messagesRouter.post("/create-poll", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), question: z.string().min(1).max(500), options: z.array(z.string().min(1).max(200)).min(2).max(12), allowMultiple: z.boolean().optional() }).parse(req.body);
  await assertCanPostInConversation(data.clerkUserId, data.conversationId);
  const { data: convPerm } = await supabaseAdmin.from("conversations").select("type, only_admins_send, disappearing_seconds").eq("id", data.conversationId).single();
  const { data: poll, error } = await supabaseAdmin.from("polls").insert({ conversation_id: data.conversationId, created_by: data.clerkUserId, question: data.question, allow_multiple: data.allowMultiple || false }).select().single();
  if (error || !poll) throw new Error(`Failed to create poll: ${error?.message}`);
  const optRows = data.options.map((t, i) => ({ poll_id: poll.id, text: t, position: i }));
  await supabaseAdmin.from("poll_options").insert(optRows);
  const expiresAt = convPerm?.disappearing_seconds ? new Date(Date.now() + convPerm.disappearing_seconds * 1000).toISOString() : null;
  const { data: message, error: msgErr } = await supabaseAdmin.from("messages").insert({ conversation_id: data.conversationId, sender_clerk_id: data.clerkUserId, poll_id: poll.id, text: `📊 ${data.question}`, expires_at: expiresAt }).select().single();
  if (msgErr) throw new Error(`Failed to send poll: ${msgErr.message}`);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  return { poll, message };
}));

messagesRouter.post("/get-poll", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ pollId: z.string().uuid() }).parse(req.body);
  const { data: poll } = await supabaseAdmin.from("polls").select("*").eq("id", data.pollId).single();
  if (!poll) return null;
  const { data: options } = await supabaseAdmin.from("poll_options").select("*").eq("poll_id", data.pollId).order("position", { ascending: true });
  const { data: votes } = await supabaseAdmin.from("poll_votes").select("option_id, clerk_user_id").eq("poll_id", data.pollId);
  return { ...poll, options: (options || []).map((o: any) => ({ ...o, votes: (votes || []).filter((v: any) => v.option_id === o.id).map((v: any) => v.clerk_user_id) })) };
}));

messagesRouter.post("/vote-poll", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), pollId: z.string().uuid(), optionId: z.string().uuid() }).parse(req.body);
  const { data: poll } = await supabaseAdmin.from("polls").select("allow_multiple, closed").eq("id", data.pollId).single();
  if (!poll) throw new Error("Poll not found");
  if (poll.closed) throw new Error("Poll is closed");
  const { data: existing } = await supabaseAdmin.from("poll_votes").select("id, option_id").eq("poll_id", data.pollId).eq("clerk_user_id", data.clerkUserId);
  const sameOption = (existing || []).find((v: any) => v.option_id === data.optionId);
  if (sameOption) { await supabaseAdmin.from("poll_votes").delete().eq("id", sameOption.id); return { action: "removed" as const }; }
  if (!poll.allow_multiple && existing?.length) await supabaseAdmin.from("poll_votes").delete().eq("poll_id", data.pollId).eq("clerk_user_id", data.clerkUserId);
  await supabaseAdmin.from("poll_votes").insert({ poll_id: data.pollId, option_id: data.optionId, clerk_user_id: data.clerkUserId });
  return { action: "added" as const };
}));

// Scheduled messages
messagesRouter.post("/schedule-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), text: z.string().min(1).max(4000), scheduledFor: z.string().datetime() }).parse(req.body);
  const { data: row, error } = await supabaseAdmin.from("scheduled_messages").insert({ clerk_user_id: data.clerkUserId, conversation_id: data.conversationId, text: data.text, scheduled_for: data.scheduledFor }).select().single();
  if (error) throw new Error(`Failed to schedule message: ${error.message}`);
  return row;
}));

messagesRouter.post("/get-scheduled-messages", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  const { data: rows } = await supabaseAdmin.from("scheduled_messages").select("*").eq("clerk_user_id", data.clerkUserId).eq("conversation_id", data.conversationId).eq("sent", false).order("scheduled_for", { ascending: true });
  return rows ?? [];
}));

messagesRouter.post("/cancel-scheduled-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), messageId: z.string().uuid() }).parse(req.body);
  const { error } = await supabaseAdmin.from("scheduled_messages").delete().eq("id", data.messageId).eq("clerk_user_id", data.clerkUserId);
  if (error) throw new Error(`Failed to cancel scheduled message: ${error.message}`);
  return { success: true };
}));

// Special messages
messagesRouter.post("/send-location-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), label: z.string().max(255).optional() }).parse(req.body);
  await assertCanPostInConversation(data.clerkUserId, data.conversationId);
  const { data: convPerm } = await supabaseAdmin.from("conversations").select("type, only_admins_send, disappearing_seconds").eq("id", data.conversationId).single();
  const expiresAt = convPerm?.disappearing_seconds ? new Date(Date.now() + convPerm.disappearing_seconds * 1000).toISOString() : null;
  const { data: message, error } = await supabaseAdmin.from("messages").insert({ conversation_id: data.conversationId, sender_clerk_id: data.clerkUserId, latitude: data.latitude, longitude: data.longitude, location_label: data.label || null, expires_at: expiresAt }).select().single();
  if (error) throw new Error(`Failed to send location: ${error.message}`);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  return message;
}));

messagesRouter.post("/send-contact-message", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), contactClerkId: z.string().min(1).max(255) }).parse(req.body);
  await assertCanPostInConversation(data.clerkUserId, data.conversationId);
  const { data: prof } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, avatar_url, username, status_message").eq("clerk_user_id", data.contactClerkId).single();
  if (!prof) throw new Error("Contact not found");
  const { data: convPerm } = await supabaseAdmin.from("conversations").select("type, only_admins_send, disappearing_seconds").eq("id", data.conversationId).single();
  const expiresAt = convPerm?.disappearing_seconds ? new Date(Date.now() + convPerm.disappearing_seconds * 1000).toISOString() : null;
  const { data: message, error } = await supabaseAdmin.from("messages").insert({ conversation_id: data.conversationId, sender_clerk_id: data.clerkUserId, contact_payload: { clerk_user_id: prof.clerk_user_id, name: prof.display_name, username: prof.username, avatar_url: prof.avatar_url }, expires_at: expiresAt }).select().single();
  if (error) throw new Error(`Failed to share contact: ${error.message}`);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  return message;
}));
