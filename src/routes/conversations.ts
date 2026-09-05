import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const conversationsRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

conversationsRouter.post("/get-conversations", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: memberships, error } = await supabaseAdmin.from("conversation_members").select("conversation_id, is_pinned, unread_count, mute_until, cleared_at, deleted_at").eq("clerk_user_id", data.clerkUserId);
  if (error || !memberships?.length) return [];
  const convIds = memberships.map((m: any) => m.conversation_id);
  const { data: conversations } = await supabaseAdmin.from("conversations").select("*").in("id", convIds).order("updated_at", { ascending: false });
  if (!conversations) return [];
  const { data: allMembers } = await supabaseAdmin.from("conversation_members").select("conversation_id, clerk_user_id").in("conversation_id", convIds);
  const otherClerkIds = [...new Set((allMembers?.filter((m: any) => m.clerk_user_id !== data.clerkUserId).map((m: any) => m.clerk_user_id) || []))];
  const { data: profiles } = await supabaseAdmin.from("profiles").select("*").in("clerk_user_id", otherClerkIds.length ? otherClerkIds : ["__none__"]);
  const results = await Promise.all(conversations
    // "Delete chat" — hide it from this user's list, unless a newer message
    // has arrived since they deleted it (same as WhatsApp: a new message
    // brings the chat back).
    .filter((conv: any) => {
      const membership = memberships.find((m: any) => m.conversation_id === conv.id);
      if (!membership?.deleted_at) return true;
      return new Date(conv.updated_at).getTime() > new Date(membership.deleted_at).getTime();
    })
    .map(async (conv: any) => {
    const membership = memberships.find((m: any) => m.conversation_id === conv.id);
    let lastMsgQuery = supabaseAdmin.from("messages").select("*").eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(1);
    // "Clear chat" — don't surface a last-message preview from before the
    // point this user cleared their history.
    if (membership?.cleared_at) lastMsgQuery = lastMsgQuery.gt("created_at", membership.cleared_at);
    const { data: lastMsg } = await lastMsgQuery.maybeSingle();
    const memberClerkIds = allMembers?.filter((m: any) => m.conversation_id === conv.id && m.clerk_user_id !== data.clerkUserId).map((m: any) => m.clerk_user_id) || [];
    const memberProfiles = profiles?.filter((p: any) => memberClerkIds.includes(p.clerk_user_id)) || [];
    const muted = membership?.mute_until && new Date(membership.mute_until).getTime() > Date.now();
    return { ...conv, isPinned: membership?.is_pinned || false, unreadCount: membership?.unread_count || 0, isMuted: !!muted, muteUntil: membership?.mute_until || null, lastMessage: lastMsg, contact: memberProfiles[0] || null, memberProfiles, memberCount: (allMembers?.filter((m: any) => m.conversation_id === conv.id) || []).length };
  }));
  return results;
}));

conversationsRouter.post("/get-or-create-direct-conversation", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), otherClerkId: z.string().min(1).max(255) }).parse(req.body);
  if (data.clerkUserId !== data.otherClerkId) {
    const { data: friendship } = await supabaseAdmin.from("contacts").select("status").eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.otherClerkId).maybeSingle();
    if (!friendship || friendship.status !== "accepted") throw new Error("You can only message accepted contacts. Send a friend request first.");
  }
  const { data: myConvs } = await supabaseAdmin.from("conversation_members").select("conversation_id").eq("clerk_user_id", data.clerkUserId);
  if (myConvs?.length) {
    const convIds = myConvs.map((c: any) => c.conversation_id);
    const { data: otherMemberships } = await supabaseAdmin.from("conversation_members").select("conversation_id").eq("clerk_user_id", data.otherClerkId).in("conversation_id", convIds);
    if (otherMemberships?.length) {
      for (const om of otherMemberships) {
        const { data: conv } = await supabaseAdmin.from("conversations").select("*").eq("id", (om as any).conversation_id).eq("type", "direct").single();
        if (conv) return conv;
      }
    }
  }
  const { data: conv, error } = await supabaseAdmin.from("conversations").insert({ type: "direct" }).select().single();
  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  await supabaseAdmin.from("conversation_members").insert([{ conversation_id: conv.id, clerk_user_id: data.clerkUserId }, { conversation_id: conv.id, clerk_user_id: data.otherClerkId }]);
  return conv;
}));

conversationsRouter.post("/mark-conversation-read", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  await supabaseAdmin.from("conversation_members").update({ unread_count: 0 }).eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId);
  return { success: true };
}));

// ── Clear chat (WhatsApp-style) ──────────────────────────────────────────────
// Wipes message history from this user's view only — the conversation stays
// in their list, other members are unaffected, and messages sent after this
// point still show normally.
conversationsRouter.post("/clear-chat", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  const { data: membership } = await supabaseAdmin.from("conversation_members").select("id").eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  if (!membership) throw new Error("You are not a member of this conversation");
  const { error } = await supabaseAdmin.from("conversation_members").update({ cleared_at: new Date().toISOString() }).eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId);
  if (error) throw new Error(`Failed to clear chat: ${error.message}`);
  return { success: true };
}));

// ── Delete chat (WhatsApp-style) ─────────────────────────────────────────────
// Removes the conversation from this user's chat list, and also clears
// history from their view (same as WhatsApp: deleting a chat implies
// clearing it). If a new message arrives afterward, the chat reappears —
// see the deleted_at filter in get-conversations.
conversationsRouter.post("/delete-chat-for-me", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  const { data: membership } = await supabaseAdmin.from("conversation_members").select("id").eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  if (!membership) throw new Error("You are not a member of this conversation");
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("conversation_members").update({ deleted_at: now, cleared_at: now }).eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId);
  if (error) throw new Error(`Failed to delete chat: ${error.message}`);
  return { success: true };
}));

conversationsRouter.post("/create-group-conversation", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), name: z.string().min(1).max(100), memberClerkIds: z.array(z.string()).min(1).max(50) }).parse(req.body);
  const { data: conv, error } = await supabaseAdmin.from("conversations").insert({ type: "group", name: data.name }).select().single();
  if (error) throw new Error(`Failed to create group: ${error.message}`);
  const allMembers = [data.clerkUserId, ...data.memberClerkIds];
  await supabaseAdmin.from("conversation_members").insert(allMembers.map((clerkId) => ({ conversation_id: conv.id, clerk_user_id: clerkId })));
  return conv;
}));

conversationsRouter.post("/get-conversation-details", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  const { data: conv } = await supabaseAdmin.from("conversations").select("*").eq("id", data.conversationId).single();
  if (!conv) throw new Error("Conversation not found");
  const { data: members } = await supabaseAdmin.from("conversation_members").select("clerk_user_id").eq("conversation_id", data.conversationId);
  const clerkIds = members?.map((m: any) => m.clerk_user_id) || [];
  const { data: profiles } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, avatar_url, is_online, last_seen").in("clerk_user_id", clerkIds.length ? clerkIds : ["__none__"]);
  return { ...conv, members: profiles || [] };
}));

conversationsRouter.post("/get-conversation-media", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ conversationId: z.string().uuid() }).parse(req.body);
  const { data: msgs } = await supabaseAdmin.from("messages").select("id, image_url, video_url, audio_url, file_url, file_name, mime_type, created_at, sender_clerk_id").eq("conversation_id", data.conversationId).or("image_url.not.is.null,video_url.not.is.null,audio_url.not.is.null,file_url.not.is.null").order("created_at", { ascending: false }).limit(200);
  return msgs || [];
}));

conversationsRouter.post("/sweep-expired-messages", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ conversationId: z.string().uuid() }).parse(req.body);
  await supabaseAdmin.from("messages").delete().eq("conversation_id", data.conversationId).lt("expires_at", new Date().toISOString());
  return { success: true };
}));

conversationsRouter.post("/get-conversation-wallpaper", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  const { data: row } = await supabaseAdmin.from("conversation_wallpapers").select("wallpaper_url").eq("clerk_user_id", data.clerkUserId).eq("conversation_id", data.conversationId).single();
  return { wallpaperUrl: row?.wallpaper_url ?? null };
}));

conversationsRouter.post("/set-conversation-wallpaper", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), wallpaperUrl: z.string().max(2048) }).parse(req.body);
  const { error } = await supabaseAdmin.from("conversation_wallpapers").upsert({ clerk_user_id: data.clerkUserId, conversation_id: data.conversationId, wallpaper_url: data.wallpaperUrl, updated_at: new Date().toISOString() }, { onConflict: "clerk_user_id,conversation_id" });
  if (error) throw new Error(`Failed to set wallpaper: ${error.message}`);
  return { success: true };
}));

conversationsRouter.post("/export-chat-history", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  const { data: msgs } = await supabaseAdmin.from("messages").select("*, profiles:sender_clerk_id(display_name, username)").eq("conversation_id", data.conversationId).order("created_at", { ascending: true });
  if (!msgs?.length) return { html: "<p>No messages to export.</p>" };
  const lines = msgs.map((m: any) => {
    const name = m.profiles?.display_name || m.profiles?.username || m.sender_clerk_id;
    const ts = new Date(m.created_at).toLocaleString();
    const body = m.is_deleted ? "<em>Message deleted</em>" : m.text ? m.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : m.image_url ? `<img src="${m.image_url}" style="max-width:300px" />` : m.file_name ? `[File: ${m.file_name}]` : "[Media]";
    return `<div style="margin-bottom:8px"><strong>${name}</strong> <span style="color:#999;font-size:12px">${ts}</span><br/>${body}</div>`;
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Chat Export</title></head><body>${lines.join("")}</body></html>`;
  return { html };
}));
