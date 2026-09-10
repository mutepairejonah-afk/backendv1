import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const channelsRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

async function assertChannelMember(clerkUserId: string, channelId: string) {
  const { data: m } = await supabaseAdmin.from("channel_members").select("role").eq("channel_id", channelId).eq("clerk_user_id", clerkUserId).maybeSingle();
  if (!m) throw new Error("You are not a member of this channel");
  return m;
}

async function assertChannelAdmin(clerkUserId: string, channelId: string) {
  const m = await assertChannelMember(clerkUserId, channelId);
  if (m.role !== "admin") throw new Error("Only channel admins can do this");
  return m;
}

async function grantChannelReadAccess(clerkUserId: string, channel: { id: string; conversation_id?: string | null }, role: "member" | "subscriber") {
  const { error } = await supabaseAdmin.from("channel_members").upsert({ channel_id: channel.id, clerk_user_id: clerkUserId, role }, { onConflict: "channel_id,clerk_user_id" });
  if (error) throw new Error(`Failed to follow channel: ${error.message}`);
  if (channel.conversation_id) {
    const { error: conversationError } = await supabaseAdmin.from("conversation_members").upsert({ conversation_id: channel.conversation_id, clerk_user_id: clerkUserId }, { onConflict: "conversation_id,clerk_user_id" });
    if (conversationError) throw new Error(`Failed to grant channel read access: ${conversationError.message}`);
  }
}

// ── Create channel ────────────────────────────────────────────────────────────
// Telegram-style: any authenticated user can create a channel. The creator
// becomes its first admin. No workspace/organization is involved.
channelsRouter.post("/create-channel", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), name: z.string().min(1).max(80), topic: z.string().max(500).optional(), isPrivate: z.boolean().optional(), isBroadcast: z.boolean().optional(), isDiscoverable: z.boolean().optional(), memberClerkIds: z.array(z.string()).max(1000).optional(), username: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/).optional(), description: z.string().max(2048).optional() }).parse(req.body);
  const slugName = data.name.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/(^-|-$)/g, "");
  if (!slugName) throw new Error("Invalid channel name");

  const { data: conv, error: convErr } = await supabaseAdmin.from("conversations").insert({ type: "channel", name: slugName, created_by: data.clerkUserId }).select().single();
  if (convErr) throw new Error(`Failed to create channel conversation: ${convErr.message}`);

  const publicSlug = `${slugName}-${randomBytes(4).toString("hex")}`;
  const { data: channel, error } = await supabaseAdmin.from("channels").insert({ conversation_id: conv.id, name: slugName, public_slug: publicSlug, topic: data.topic || null, is_private: data.isPrivate || false, is_broadcast: data.isBroadcast || false, is_discoverable: data.isDiscoverable ?? true, username: data.username?.toLowerCase() || null, description: data.description || null, created_by: data.clerkUserId }).select().single();
  if (error) throw new Error(`Failed to create channel: ${error.message}`);

  const members = [data.clerkUserId, ...(data.memberClerkIds || []).filter((id) => id !== data.clerkUserId)];
  await supabaseAdmin.from("channel_members").insert(members.map((clerkId) => ({ channel_id: channel.id, clerk_user_id: clerkId, role: clerkId === data.clerkUserId ? "admin" : "member" })));
  for (const clerkId of members) {
    await supabaseAdmin.from("conversation_members").upsert({ conversation_id: conv.id, clerk_user_id: clerkId }, { onConflict: "conversation_id,clerk_user_id" });
  }

  return { ...channel, conversation: conv };
}));

// ── Update channel settings (broadcast mode, discoverability, topic) ────────
channelsRouter.post("/update-channel-settings", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), topic: z.string().max(500).optional(), username: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/).optional(), description: z.string().max(2048).optional(), commentsEnabled: z.boolean().optional(), signaturesEnabled: z.boolean().optional(), defaultReactions: z.array(z.string().max(12)).max(20).optional(), permissions: z.record(z.boolean()).optional(), isBroadcast: z.boolean().optional(), isDiscoverable: z.boolean().optional(), slowModeSeconds: z.number().int().min(0).max(86400).optional(), inviteExpiresAt: z.string().datetime().nullable().optional(), settings: z.record(z.unknown()).optional() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  const patch: Record<string, unknown> = {};
  if (data.topic !== undefined) patch.topic = data.topic;
  if (data.username !== undefined) patch.username = data.username.toLowerCase();
  if (data.description !== undefined) patch.description = data.description;
  if (data.commentsEnabled !== undefined) patch.comments_enabled = data.commentsEnabled;
  if (data.signaturesEnabled !== undefined) patch.signatures_enabled = data.signaturesEnabled;
  if (data.defaultReactions !== undefined) patch.default_reactions = data.defaultReactions;
  if (data.permissions !== undefined) patch.permissions = data.permissions;
  if (data.isBroadcast !== undefined) patch.is_broadcast = data.isBroadcast;
  if (data.isDiscoverable !== undefined) patch.is_discoverable = data.isDiscoverable;
  if (data.slowModeSeconds !== undefined) patch.slow_mode_seconds = data.slowModeSeconds;
  if (data.inviteExpiresAt !== undefined) patch.invite_expires_at = data.inviteExpiresAt;
  if (data.settings !== undefined) patch.settings = data.settings;
  const { data: updated, error } = await supabaseAdmin.from("channels").update(patch).eq("id", data.channelId).select().single();
  if (error) throw new Error(`Failed to update channel: ${error.message}`);
  return updated;
}));

// ── Regenerate invite link (admin only — invalidates the old link) ──────────
channelsRouter.post("/regenerate-channel-invite", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  const newCode = randomBytes(9).toString("base64").replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
  const { data: updated, error } = await supabaseAdmin.from("channels").update({ invite_code: newCode }).eq("id", data.channelId).select().single();
  if (error) throw new Error(`Failed to regenerate invite link: ${error.message}`);
  return updated;
}));

// ── Preview a channel by invite code (no membership required — like tapping
//    a t.me/joinchat/XXXX link before you've joined) ─────────────────────────
channelsRouter.post("/preview-channel-by-invite", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), inviteCode: z.string().min(1).max(64) }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("id, name, topic, is_private, is_broadcast, member_count, invite_expires_at").eq("invite_code", data.inviteCode).is("archived_at", null).maybeSingle();
  if (!channel) throw new Error("This invite link is invalid or has expired");
  if (channel.invite_expires_at && new Date(channel.invite_expires_at) <= new Date()) throw new Error("This invite link has expired");
  const { data: existingMembership } = await supabaseAdmin.from("channel_members").select("role").eq("channel_id", channel.id).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  return { ...channel, alreadyMember: !!existingMembership };
}));

// ── Join via invite link (instant, like Telegram — no approval needed) ──────
channelsRouter.post("/join-channel-by-invite", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), inviteCode: z.string().min(1).max(64) }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("invite_code", data.inviteCode).is("archived_at", null).maybeSingle();
  if (!channel) throw new Error("This invite link is invalid or has expired");
  if (channel.invite_expires_at && new Date(channel.invite_expires_at) <= new Date()) throw new Error("This invite link has expired");
  await grantChannelReadAccess(data.clerkUserId, channel, "member");
  return channel;
}));

// ── List channels I belong to ────────────────────────────────────────────────
channelsRouter.post("/get-channels", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: myMemberships } = await supabaseAdmin.from("channel_members").select("channel_id, role, muted, last_read_at").eq("clerk_user_id", data.clerkUserId);
  const ids = (myMemberships || []).map((m: any) => m.channel_id);
  if (!ids.length) return [];
  const { data: channels } = await supabaseAdmin.from("channels").select("*").in("id", ids).is("archived_at", null).order("name", { ascending: true });
  return (channels || []).map((c: any) => ({ ...c, isMember: true, membership: myMemberships?.find((m: any) => m.channel_id === c.id) || null }));
}));

// ── Join / leave ──────────────────────────────────────────────────────────────
channelsRouter.post("/join-channel", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  if (channel.is_private) throw new Error("This is a private channel — ask an admin to add you");
  await grantChannelReadAccess(data.clerkUserId, channel, "member");
  return { success: true };
}));

channelsRouter.post("/leave-channel", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  await supabaseAdmin.from("channel_members").delete().eq("channel_id", data.channelId).eq("clerk_user_id", data.clerkUserId);
  return { success: true };
}));

// ── Add / remove members (channel admin only) ────────────────────────────────
channelsRouter.post("/add-channel-member", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), targetClerkId: z.string().min(1).max(255).optional(), targetUsername: z.string().min(1).max(40).optional() }).refine((value) => value.targetClerkId || value.targetUsername, { message: "Provide a username" }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  let targetClerkId = data.targetClerkId;
  if (!targetClerkId && data.targetUsername) {
    const { data: profile } = await supabaseAdmin.from("profiles").select("clerk_user_id, username").ilike("username", data.targetUsername.replace(/^@/, "")).maybeSingle();
    if (!profile) throw new Error("No user found for that username");
    targetClerkId = profile.clerk_user_id;
  }
  if (!targetClerkId) throw new Error("Provide a username");
  const { error: memberError } = await supabaseAdmin.from("channel_members").upsert({ channel_id: data.channelId, clerk_user_id: targetClerkId, role: "member" }, { onConflict: "channel_id,clerk_user_id" });
  if (memberError) throw new Error(`Failed to add channel member: ${memberError.message}`);
  if (channel.conversation_id) await supabaseAdmin.from("conversation_members").upsert({ conversation_id: channel.conversation_id, clerk_user_id: targetClerkId }, { onConflict: "conversation_id,clerk_user_id" });
  return { success: true, username: data.targetUsername?.replace(/^@/, "") || null };
}));

channelsRouter.post("/remove-channel-member", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), targetClerkId: z.string().min(1).max(255) }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  await supabaseAdmin.from("channel_members").delete().eq("channel_id", data.channelId).eq("clerk_user_id", data.targetClerkId);
  return { success: true };
}));

// ── Archive (channel admin only) ─────────────────────────────────────────────
channelsRouter.post("/archive-channel", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  const { error } = await supabaseAdmin.from("channels").update({ archived_at: new Date().toISOString() }).eq("id", data.channelId);
  if (error) throw new Error(`Failed to archive channel: ${error.message}`);
  return { success: true };
}));

channelsRouter.post("/restore-channel", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  const { error } = await supabaseAdmin.from("channels").update({ archived_at: null }).eq("id", data.channelId);
  if (error) throw new Error(`Failed to restore channel: ${error.message}`);
  return { success: true };
}));

channelsRouter.post("/set-channel-mute", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), muted: z.boolean() }).parse(req.body);
  await assertChannelMember(data.clerkUserId, data.channelId);
  const { error } = await supabaseAdmin.from("channel_members").update({ muted: data.muted }).eq("channel_id", data.channelId).eq("clerk_user_id", data.clerkUserId);
  if (error) throw new Error(`Failed to update channel mute: ${error.message}`);
  return { success: true, muted: data.muted };
}));

channelsRouter.post("/send-channel-post", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), text: z.string().max(5000).optional(), imageUrl: z.string().url().max(2048).optional(), videoUrl: z.string().url().max(2048).optional(), audioUrl: z.string().url().max(2048).optional(), fileUrl: z.string().url().max(2048).optional(), fileName: z.string().max(255).optional(), mimeType: z.string().max(120).optional(), thumbnailUrl: z.string().url().max(2048).optional(), durationSeconds: z.number().int().min(0).max(86400).optional() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("id, conversation_id, archived_at").eq("id", data.channelId).maybeSingle();
  if (!channel || !channel.conversation_id || channel.archived_at) throw new Error("Channel is unavailable");
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  if (!data.text?.trim() && !data.imageUrl && !data.videoUrl && !data.audioUrl && !data.fileUrl) throw new Error("A channel post needs text or media");
  const mediaType = data.videoUrl ? "video" : data.audioUrl ? "audio" : data.imageUrl ? "image" : data.fileUrl ? "file" : null;
  const { data: message, error } = await supabaseAdmin.from("messages").insert({ conversation_id: channel.conversation_id, sender_clerk_id: data.clerkUserId, text: data.text || null, image_url: data.imageUrl || null, video_url: data.videoUrl || null, audio_url: data.audioUrl || null, file_url: data.fileUrl || null, file_name: data.fileName || null, mime_type: data.mimeType || null, media_type: mediaType, thumbnail_url: data.thumbnailUrl || null, duration_seconds: data.durationSeconds ?? null }).select().single();
  if (error) throw new Error(`Failed to publish channel post: ${error.message}`);
  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", channel.conversation_id);
  return message;
}));

// ── Channel info + members list ──────────────────────────────────────────────
channelsRouter.post("/get-channel-admins", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  await assertChannelMember(data.clerkUserId, data.channelId);
  const { data: admins, error } = await supabaseAdmin.from("channel_members").select("clerk_user_id, role, joined_at").eq("channel_id", data.channelId).eq("role", "admin").order("joined_at", { ascending: true });
  if (error) throw new Error(`Failed to load channel admins: ${error.message}`);
  const ids = (admins || []).map((admin: any) => admin.clerk_user_id);
  const { data: profiles } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, username, avatar_url").in("clerk_user_id", ids.length ? ids : ["__none__"]);
  return (admins || []).map((admin: any) => ({ ...admin, profile: (profiles || []).find((profile: any) => profile.clerk_user_id === admin.clerk_user_id) || null }));
}));

channelsRouter.post("/set-channel-admin", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), targetClerkId: z.string().min(1).max(255), isAdmin: z.boolean() }).parse(req.body);
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  if (data.targetClerkId === data.clerkUserId && !data.isAdmin) throw new Error("The channel must keep an administrator");
  const { error } = await supabaseAdmin.from("channel_members").update({ role: data.isAdmin ? "admin" : "member" }).eq("channel_id", data.channelId).eq("clerk_user_id", data.targetClerkId);
  if (error) throw new Error(`Failed to update channel admin: ${error.message}`);
  return { success: true, isAdmin: data.isAdmin };
}));

channelsRouter.post("/search-channel-posts", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), query: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(100).optional() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("conversation_id").eq("id", data.channelId).maybeSingle();
  if (!channel?.conversation_id) throw new Error("Channel not found");
  await assertChannelMember(data.clerkUserId, data.channelId);
  const { data: posts, error } = await supabaseAdmin.from("messages").select("*").eq("conversation_id", channel.conversation_id).ilike("text", `%${data.query}%`).order("created_at", { ascending: false }).limit(data.limit ?? 50);
  if (error) throw new Error(`Failed to search channel posts: ${error.message}`);
  return posts || [];
}));

channelsRouter.post("/pin-channel-post", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), messageId: z.string().uuid(), pinned: z.boolean().optional() }).parse(req.body);
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  const { data: channel } = await supabaseAdmin.from("channels").select("conversation_id").eq("id", data.channelId).maybeSingle();
  if (!channel?.conversation_id) throw new Error("Channel not found");
  const { data: message } = await supabaseAdmin.from("messages").select("id").eq("id", data.messageId).eq("conversation_id", channel.conversation_id).maybeSingle();
  if (!message) throw new Error("Post not found in this channel");
  const pinned = data.pinned ?? true;
  const { error } = await supabaseAdmin.from("messages").update({ pinned, pinned_at: pinned ? new Date().toISOString() : null, pinned_by: pinned ? data.clerkUserId : null }).eq("id", data.messageId);
  if (error) throw new Error(`Failed to update pinned post: ${error.message}`);
  return { success: true, pinned };
}));

channelsRouter.post("/get-channel-info", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  const membership = await assertChannelMember(data.clerkUserId, data.channelId);

  // Broadcast-channel subscriber anonymity: subscribers must not be able to
  // see who else follows the channel. Only channel admins get the roster;
  // everyone else gets an aggregated count only.
  const isChannelAdmin = membership.role === "admin";
  if (channel.is_broadcast && !isChannelAdmin) {
    const { count } = await supabaseAdmin.from("channel_members").select("id", { count: "exact", head: true }).eq("channel_id", data.channelId);
    return { ...channel, subscriberCount: count || 0, members: [] };
  }

  const { data: members } = await supabaseAdmin.from("channel_members").select("clerk_user_id, role, joined_at").eq("channel_id", data.channelId);
  const ids = members?.map((m: any) => m.clerk_user_id) || [];
  const { data: profiles } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, avatar_url, username").in("clerk_user_id", ids.length ? ids : ["__none__"]);
  return { ...channel, members: (members || []).map((m: any) => ({ ...m, profile: profiles?.find((p: any) => p.clerk_user_id === m.clerk_user_id) || null })) };
}));

// ── Mark channel read ─────────────────────────────────────────────────────────
channelsRouter.post("/mark-channel-read", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  await supabaseAdmin.from("channel_members").update({ last_read_at: new Date().toISOString() }).eq("channel_id", data.channelId).eq("clerk_user_id", data.clerkUserId);
  return { success: true };
}));

// ── Public discovery and Telegram-style follow subscriptions ─────────────────
channelsRouter.post("/discover-channels", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), query: z.string().trim().max(100).optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().datetime().optional() }).parse(req.body);
  let query = supabaseAdmin.from("channels").select("id, conversation_id, name, public_slug, topic, is_broadcast, member_count, created_at").eq("is_private", false).eq("is_discoverable", true).is("archived_at", null).order("created_at", { ascending: false }).limit(data.limit ?? 25);
  if (data.query) query = query.ilike("name", `%${data.query}%`);
  if (data.cursor) query = query.lt("created_at", data.cursor);
  const { data: channels, error } = await query;
  if (error) throw new Error(`Failed to discover channels: ${error.message}`);
  const ids = (channels ?? []).map((channel: any) => channel.id);
  const { data: follows } = ids.length ? await supabaseAdmin.from("channel_members").select("channel_id").eq("clerk_user_id", data.clerkUserId).eq("role", "subscriber").in("channel_id", ids) : { data: [] };
  const followed = new Set((follows ?? []).map((row: any) => row.channel_id));
  return (channels ?? []).map((channel: any) => ({ ...channel, isFollowing: followed.has(channel.id) }));
}));

channelsRouter.post("/get-followed-channels", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: follows, error } = await supabaseAdmin.from("channel_members").select("channel_id, joined_at, muted, last_read_at").eq("clerk_user_id", data.clerkUserId).eq("role", "subscriber").order("joined_at", { ascending: false });
  if (error) throw new Error(`Failed to load followed channels: ${error.message}`);
  const ids = (follows ?? []).map((row: any) => row.channel_id);
  if (!ids.length) return [];
  const { data: channels, error: channelError } = await supabaseAdmin.from("channels").select("id, conversation_id, name, public_slug, topic, is_broadcast, member_count, created_at").in("id", ids).is("archived_at", null);
  if (channelError) throw new Error(`Failed to load followed channels: ${channelError.message}`);
  return (channels ?? []).map((channel: any) => ({ ...channel, subscription: follows?.find((row: any) => row.channel_id === channel.id) ?? null }));
}));

channelsRouter.post("/follow-channel", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("id, conversation_id, name, is_private, is_discoverable, archived_at").eq("id", data.channelId).maybeSingle();
  if (!channel || channel.archived_at || channel.is_private || !channel.is_discoverable) throw new Error("This channel is not publicly followable");
  await grantChannelReadAccess(data.clerkUserId, channel, "subscriber");
  return { success: true, channelId: channel.id, following: true };
}));

channelsRouter.post("/unfollow-channel", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("id, conversation_id").eq("id", data.channelId).maybeSingle();
  if (!channel) throw new Error("Channel not found");
  const { error } = await supabaseAdmin.from("channel_members").delete().eq("channel_id", data.channelId).eq("clerk_user_id", data.clerkUserId).eq("role", "subscriber");
  if (error) throw new Error(`Failed to unfollow channel: ${error.message}`);
  if (channel.conversation_id) await supabaseAdmin.from("conversation_members").delete().eq("conversation_id", channel.conversation_id).eq("clerk_user_id", data.clerkUserId);
  return { success: true, channelId: channel.id, following: false };
}));

channelsRouter.post("/get-channel-feed", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), before: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).optional() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("id, conversation_id, is_private, is_discoverable").eq("id", data.channelId).maybeSingle();
  if (!channel || !channel.conversation_id) throw new Error("Channel not found");
  const { data: membership } = await supabaseAdmin.from("channel_members").select("role").eq("channel_id", data.channelId).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  if (!membership) throw new Error("Follow or join this channel to read its posts");
  let query = supabaseAdmin.from("messages").select("*").eq("conversation_id", channel.conversation_id).order("created_at", { ascending: false }).limit(data.limit ?? 50);
  if (data.before) query = query.lt("created_at", data.before);
  const { data: messages, error } = await query;
  if (error) throw new Error(`Failed to load channel feed: ${error.message}`);
  return (messages ?? []).reverse();
}));


channelsRouter.post("/request-channel-join", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), message: z.string().max(500).optional() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("id, is_private, archived_at").eq("id", data.channelId).maybeSingle();
  if (!channel || channel.archived_at) throw new Error("Channel not found");
  if (!channel.is_private) throw new Error("Public channels can be joined directly");
  const { data: request, error } = await supabaseAdmin.from("channel_join_requests").upsert({ channel_id: data.channelId, clerk_user_id: data.clerkUserId, message: data.message || null, status: "pending", reviewed_by: null, reviewed_at: null }, { onConflict: "channel_id,clerk_user_id" }).select().single();
  if (error) throw new Error(`Failed to request channel access: ${error.message}`);
  return request;
}));

channelsRouter.post("/get-channel-join-requests", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), status: z.enum(["pending", "approved", "rejected"]).optional() }).parse(req.body);
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  let query = supabaseAdmin.from("channel_join_requests").select("*").eq("channel_id", data.channelId).order("created_at", { ascending: false }).limit(200);
  if (data.status) query = query.eq("status", data.status);
  const { data: requests, error } = await query;
  if (error) throw new Error(`Failed to load channel join requests: ${error.message}`);
  return requests || [];
}));

channelsRouter.post("/review-channel-join-request", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), requestId: z.string().uuid(), decision: z.enum(["approved", "rejected"]) }).parse(req.body);
  const { data: request } = await supabaseAdmin.from("channel_join_requests").select("*").eq("id", data.requestId).maybeSingle();
  if (!request) throw new Error("Join request not found");
  await assertChannelAdmin(data.clerkUserId, request.channel_id);
  const { error } = await supabaseAdmin.from("channel_join_requests").update({ status: data.decision, reviewed_by: data.clerkUserId, reviewed_at: new Date().toISOString() }).eq("id", data.requestId);
  if (error) throw new Error(`Failed to review join request: ${error.message}`);
  if (data.decision === "approved") {
    const { data: channel } = await supabaseAdmin.from("channels").select("id, conversation_id").eq("id", request.channel_id).single();
    if (channel) await grantChannelReadAccess(request.clerk_user_id, channel, "member");
  }
  return { success: true, decision: data.decision };
}));

channelsRouter.post("/get-channel-stats", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid() }).parse(req.body);
  await assertChannelMember(data.clerkUserId, data.channelId);
  const { data: channel } = await supabaseAdmin.from("channels").select("id, conversation_id, member_count").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  const { count: postCount } = channel.conversation_id ? await supabaseAdmin.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", channel.conversation_id) : { count: 0 };
  const { count: adminCount } = await supabaseAdmin.from("channel_members").select("id", { count: "exact", head: true }).eq("channel_id", data.channelId).eq("role", "admin");
  return { subscriberCount: channel.member_count || 0, postCount: postCount || 0, adminCount: adminCount || 0 };
}));
