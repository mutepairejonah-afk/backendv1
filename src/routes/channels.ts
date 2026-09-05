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
  const data = z.object({ clerkUserId: z.string().min(1).max(255), name: z.string().min(1).max(80), topic: z.string().max(500).optional(), isPrivate: z.boolean().optional(), isBroadcast: z.boolean().optional(), isDiscoverable: z.boolean().optional(), memberClerkIds: z.array(z.string()).max(1000).optional() }).parse(req.body);
  const slugName = data.name.toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/(^-|-$)/g, "");
  if (!slugName) throw new Error("Invalid channel name");

  const { data: conv, error: convErr } = await supabaseAdmin.from("conversations").insert({ type: "channel", name: slugName, created_by: data.clerkUserId }).select().single();
  if (convErr) throw new Error(`Failed to create channel conversation: ${convErr.message}`);

  const publicSlug = `${slugName}-${randomBytes(4).toString("hex")}`;
  const { data: channel, error } = await supabaseAdmin.from("channels").insert({ conversation_id: conv.id, name: slugName, public_slug: publicSlug, topic: data.topic || null, is_private: data.isPrivate || false, is_broadcast: data.isBroadcast || false, is_discoverable: data.isDiscoverable ?? true, created_by: data.clerkUserId }).select().single();
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
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), topic: z.string().max(500).optional(), isBroadcast: z.boolean().optional(), isDiscoverable: z.boolean().optional() }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  const patch: Record<string, unknown> = {};
  if (data.topic !== undefined) patch.topic = data.topic;
  if (data.isBroadcast !== undefined) patch.is_broadcast = data.isBroadcast;
  if (data.isDiscoverable !== undefined) patch.is_discoverable = data.isDiscoverable;
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
  const { data: channel } = await supabaseAdmin.from("channels").select("id, name, topic, is_private, is_broadcast, member_count").eq("invite_code", data.inviteCode).is("archived_at", null).maybeSingle();
  if (!channel) throw new Error("This invite link is invalid or has expired");
  const { data: existingMembership } = await supabaseAdmin.from("channel_members").select("role").eq("channel_id", channel.id).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  return { ...channel, alreadyMember: !!existingMembership };
}));

// ── Join via invite link (instant, like Telegram — no approval needed) ──────
channelsRouter.post("/join-channel-by-invite", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), inviteCode: z.string().min(1).max(64) }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("invite_code", data.inviteCode).is("archived_at", null).maybeSingle();
  if (!channel) throw new Error("This invite link is invalid or has expired");
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
  const data = z.object({ clerkUserId: z.string().min(1).max(255), channelId: z.string().uuid(), targetClerkId: z.string().min(1).max(255) }).parse(req.body);
  const { data: channel } = await supabaseAdmin.from("channels").select("*").eq("id", data.channelId).single();
  if (!channel) throw new Error("Channel not found");
  await assertChannelAdmin(data.clerkUserId, data.channelId);
  await supabaseAdmin.from("channel_members").upsert({ channel_id: data.channelId, clerk_user_id: data.targetClerkId, role: "member" }, { onConflict: "channel_id,clerk_user_id" });
  if (channel.conversation_id) await supabaseAdmin.from("conversation_members").upsert({ conversation_id: channel.conversation_id, clerk_user_id: data.targetClerkId }, { onConflict: "conversation_id,clerk_user_id" });
  return { success: true };
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

// ── Channel info + members list ──────────────────────────────────────────────
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
