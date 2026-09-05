import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const groupsRouter = Router();

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

function genInviteCode() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

groupsRouter.post("/create-group", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), name: z.string().min(1).max(100), description: z.string().max(500).optional(), avatarUrl: z.string().url().max(2048).optional(), memberClerkIds: z.array(z.string().min(1).max(255)).min(1).max(256) }).parse(req.body);
  const { data: conv, error } = await supabaseAdmin.from("conversations").insert({ type: "group", name: data.name, description: data.description || null, avatar_url: data.avatarUrl || null, created_by: data.clerkUserId }).select().single();
  if (error) throw new Error(`Failed to create group: ${error.message}`);
  const allMembers = [data.clerkUserId, ...data.memberClerkIds.filter((m) => m !== data.clerkUserId)];
  const memberRows = allMembers.map((clerkId) => ({ conversation_id: conv.id, clerk_user_id: clerkId, role: clerkId === data.clerkUserId ? "admin" : "member" }));
  await supabaseAdmin.from("conversation_members").insert(memberRows);
  return conv;
}));

groupsRouter.post("/get-group-info", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  const { data: conv } = await supabaseAdmin.from("conversations").select("*").eq("id", data.conversationId).single();
  if (!conv) throw new Error("Conversation not found");
  const { data: members } = await supabaseAdmin.from("conversation_members").select("clerk_user_id, role, joined_at, mute_until").eq("conversation_id", data.conversationId);
  const ids = members?.map((m: any) => m.clerk_user_id) || [];
  const { data: profiles } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, avatar_url, username, is_online, status_message").in("clerk_user_id", ids.length ? ids : ["__none__"]);
  const myMembership = members?.find((m: any) => m.clerk_user_id === data.clerkUserId);
  const enriched = (members || []).map((m: any) => ({ ...m, profile: profiles?.find((p: any) => p.clerk_user_id === m.clerk_user_id) || null })).sort((a: any, b: any) => {
    if (a.role === "admin" && b.role !== "admin") return -1;
    if (b.role === "admin" && a.role !== "admin") return 1;
    return (a.profile?.display_name || "").localeCompare(b.profile?.display_name || "");
  });
  return { ...conv, members: enriched, myRole: myMembership?.role || null, myMuteUntil: myMembership?.mute_until || null };
}));

groupsRouter.post("/update-group-info", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), name: z.string().min(1).max(100).optional(), description: z.string().max(500).nullable().optional(), avatarUrl: z.string().url().max(2048).nullable().optional() }).parse(req.body);
  const { data: c } = await supabaseAdmin.from("conversations").select("*").eq("id", data.conversationId).single();
  if (!c || c.type !== "group") throw new Error("Not a group conversation");
  const { data: m } = await supabaseAdmin.from("conversation_members").select("role").eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  if (!m) throw new Error("You are not a member of this group");
  if (c.only_admins_edit && m.role !== "admin") throw new Error("Only admins can edit group info");
  const updates: Record<string, any> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;
  if (data.avatarUrl !== undefined) updates.avatar_url = data.avatarUrl;
  updates.updated_at = new Date().toISOString();
  const { data: updated, error } = await supabaseAdmin.from("conversations").update(updates).eq("id", data.conversationId).select().single();
  if (error) throw new Error(`Failed to update group: ${error.message}`);
  return updated;
}));

groupsRouter.post("/update-group-permissions", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), onlyAdminsSend: z.boolean().optional(), onlyAdminsEdit: z.boolean().optional(), disappearingSeconds: z.number().int().min(0).max(60 * 60 * 24 * 90).nullable().optional() }).parse(req.body);
  await assertGroupAdmin(data.clerkUserId, data.conversationId);
  const updates: Record<string, any> = {};
  if (data.onlyAdminsSend !== undefined) updates.only_admins_send = data.onlyAdminsSend;
  if (data.onlyAdminsEdit !== undefined) updates.only_admins_edit = data.onlyAdminsEdit;
  if (data.disappearingSeconds !== undefined) updates.disappearing_seconds = data.disappearingSeconds && data.disappearingSeconds > 0 ? data.disappearingSeconds : null;
  const { error } = await supabaseAdmin.from("conversations").update(updates).eq("id", data.conversationId);
  if (error) throw new Error(`Failed to update permissions: ${error.message}`);
  return { success: true };
}));

groupsRouter.post("/set-group-member-role", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), memberClerkId: z.string().min(1).max(255), role: z.enum(["admin", "member"]) }).parse(req.body);
  await assertGroupAdmin(data.clerkUserId, data.conversationId);
  if (data.role === "member") {
    const { data: admins } = await supabaseAdmin.from("conversation_members").select("clerk_user_id").eq("conversation_id", data.conversationId).eq("role", "admin");
    if ((admins?.length || 0) <= 1 && admins?.[0]?.clerk_user_id === data.memberClerkId) throw new Error("Cannot demote the last admin");
  }
  const { error } = await supabaseAdmin.from("conversation_members").update({ role: data.role }).eq("conversation_id", data.conversationId).eq("clerk_user_id", data.memberClerkId);
  if (error) throw new Error(`Failed to update role: ${error.message}`);
  return { success: true };
}));

groupsRouter.post("/add-group-member", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), memberClerkId: z.string().min(1).max(255) }).parse(req.body);
  const { data: conv } = await supabaseAdmin.from("conversations").select("type").eq("id", data.conversationId).single();
  if (!conv || conv.type !== "group") throw new Error("Not a group conversation");
  const { data: callerMember } = await supabaseAdmin.from("conversation_members").select("id, role").eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId).single();
  if (!callerMember) throw new Error("You are not a member of this group");
  if (callerMember.role !== "admin") throw new Error("Only admins can add members");
  const { data: existing } = await supabaseAdmin.from("conversation_members").select("id").eq("conversation_id", data.conversationId).eq("clerk_user_id", data.memberClerkId).maybeSingle();
  if (existing) throw new Error("User is already a member");
  const { error } = await supabaseAdmin.from("conversation_members").insert({ conversation_id: data.conversationId, clerk_user_id: data.memberClerkId, role: "member" });
  if (error) throw new Error(`Failed to add member: ${error.message}`);
  return { success: true };
}));

groupsRouter.post("/remove-group-member", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), memberClerkId: z.string().min(1).max(255) }).parse(req.body);
  const { data: conv } = await supabaseAdmin.from("conversations").select("type").eq("id", data.conversationId).single();
  if (!conv || conv.type !== "group") throw new Error("Not a group conversation");
  const { data: callerMember } = await supabaseAdmin.from("conversation_members").select("id, role").eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId).single();
  if (!callerMember) throw new Error("You are not a member of this group");
  if (callerMember.role !== "admin") throw new Error("Only admins can remove members");
  if (data.memberClerkId === data.clerkUserId) throw new Error("Use leave group to remove yourself");
  const { error } = await supabaseAdmin.from("conversation_members").delete().eq("conversation_id", data.conversationId).eq("clerk_user_id", data.memberClerkId);
  if (error) throw new Error(`Failed to remove member: ${error.message}`);
  return { success: true };
}));

groupsRouter.post("/leave-group", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  const { data: conv } = await supabaseAdmin.from("conversations").select("type").eq("id", data.conversationId).single();
  if (!conv || conv.type !== "group") throw new Error("Not a group conversation");
  const { error } = await supabaseAdmin.from("conversation_members").delete().eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId);
  if (error) throw new Error(`Failed to leave group: ${error.message}`);
  return { success: true };
}));

groupsRouter.post("/generate-invite-code", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid() }).parse(req.body);
  await assertGroupAdmin(data.clerkUserId, data.conversationId);
  let code = "";
  for (let i = 0; i < 5; i++) {
    const candidate = genInviteCode();
    const { data: existing } = await supabaseAdmin.from("conversations").select("id").eq("invite_code", candidate).maybeSingle();
    if (!existing) { code = candidate; break; }
  }
  if (!code) throw new Error("Could not allocate invite code, try again");
  const { error } = await supabaseAdmin.from("conversations").update({ invite_code: code }).eq("id", data.conversationId);
  if (error) throw new Error(`Failed to set invite code: ${error.message}`);
  return { code };
}));

groupsRouter.post("/lookup-invite", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ code: z.string().min(4).max(40) }).parse(req.body);
  const { data: conv } = await supabaseAdmin.from("conversations").select("id, name, description, avatar_url, type").eq("invite_code", data.code).maybeSingle();
  if (!conv || conv.type !== "group") return null;
  const { count } = await supabaseAdmin.from("conversation_members").select("id", { count: "exact", head: true }).eq("conversation_id", conv.id);
  return { ...conv, memberCount: count || 0 };
}));

groupsRouter.post("/join-group-by-invite", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), code: z.string().min(4).max(40) }).parse(req.body);
  const { data: conv } = await supabaseAdmin.from("conversations").select("id, type").eq("invite_code", data.code).maybeSingle();
  if (!conv || conv.type !== "group") throw new Error("Invite link is invalid or expired");
  const { data: existing } = await supabaseAdmin.from("conversation_members").select("id").eq("conversation_id", conv.id).eq("clerk_user_id", data.clerkUserId).maybeSingle();
  if (existing) return { conversationId: conv.id, alreadyMember: true };
  const { error } = await supabaseAdmin.from("conversation_members").insert({ conversation_id: conv.id, clerk_user_id: data.clerkUserId, role: "member" });
  if (error) throw new Error(`Failed to join group: ${error.message}`);
  return { conversationId: conv.id, alreadyMember: false };
}));

groupsRouter.post("/upload-group-avatar", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), fileBase64: z.string().min(1), contentType: z.string().min(1).max(100) }).parse(req.body);
  const { data: conv } = await supabaseAdmin.from("conversations").select("only_admins_edit, type").eq("id", data.conversationId).single();
  if (!conv || conv.type !== "group") throw new Error("Not a group");
  if (conv.only_admins_edit) { await assertGroupAdmin(data.clerkUserId, data.conversationId); }
  else {
    const { data: m } = await supabaseAdmin.from("conversation_members").select("id").eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId).maybeSingle();
    if (!m) throw new Error("You are not a member of this group");
  }
  const buffer = Buffer.from(data.fileBase64, "base64");
  const ext = data.contentType.split("/")[1] || "jpg";
  const storagePath = `group-avatars/${data.conversationId}/${Date.now()}.${ext}`;
  const { error: upErr } = await supabaseAdmin.storage.from("chat-media").upload(storagePath, buffer, { contentType: data.contentType, upsert: true });
  if (upErr) throw new Error(`Avatar upload failed: ${upErr.message}`);
  const { data: urlData } = supabaseAdmin.storage.from("chat-media").getPublicUrl(storagePath);
  await supabaseAdmin.from("conversations").update({ avatar_url: urlData.publicUrl, updated_at: new Date().toISOString() }).eq("id", data.conversationId);
  return { publicUrl: urlData.publicUrl };
}));

groupsRouter.post("/set-conversation-mute", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), conversationId: z.string().uuid(), muteSeconds: z.number().int().min(0).max(60 * 60 * 24 * 365).nullable() }).parse(req.body);
  const muteUntil = data.muteSeconds === null ? null : data.muteSeconds === 0 ? new Date(Date.now() + 60 * 60 * 24 * 365 * 10 * 1000).toISOString() : new Date(Date.now() + data.muteSeconds * 1000).toISOString();
  const { error } = await supabaseAdmin.from("conversation_members").update({ mute_until: muteUntil }).eq("conversation_id", data.conversationId).eq("clerk_user_id", data.clerkUserId);
  if (error) throw new Error(`Failed to update mute: ${error.message}`);
  return { muteUntil };
}));
