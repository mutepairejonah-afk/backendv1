import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";

export const spacesRouter = Router();
const reply = (res: any, fn: () => Promise<any>) => fn().then((value) => res.json(value)).catch((err: any) => res.status(err?.name === "ZodError" ? 400 : 500).json({ error: process.env.NODE_ENV === "production" && err?.name !== "ZodError" ? "Internal server error" : (err?.message || "Internal server error") }));
const spaceId = z.string().uuid();
const filters = z.object({
  title: z.string().min(1).max(80).optional(), icon: z.string().min(1).max(8).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  includeUnreadOnly: z.boolean().optional(), includeDirect: z.boolean().optional(),
  includeGroups: z.boolean().optional(), includeChannels: z.boolean().optional(), sortOrder: z.number().int().min(0).optional(),
});
const owner = (req: AuthRequest) => req.clerkUserId;

async function ownedSpace(req: AuthRequest, id: string) {
  const { data, error } = await supabaseAdmin.from("smart_spaces").select("*").eq("id", id).eq("owner_clerk_user_id", owner(req)).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Smart Space not found");
  return data;
}
async function serialize(space: any) {
  const { data: rules, error } = await supabaseAdmin.from("smart_space_rules").select("chat_id, entity_type, rule_type").eq("space_id", space.id);
  if (error) throw new Error(error.message);
  return { id: space.id, title: space.title, icon: space.icon, color: space.color, includeUnreadOnly: space.include_unread_only, includeDirect: space.include_direct, includeGroups: space.include_groups, includeChannels: space.include_channels, sortOrder: space.sort_order, whitelist: (rules || []).filter((r: any) => r.rule_type === "whitelist").map((r: any) => ({ chatId: r.chat_id, entityType: r.entity_type })), blacklist: (rules || []).filter((r: any) => r.rule_type === "blacklist").map((r: any) => ({ chatId: r.chat_id, entityType: r.entity_type })), createdAt: space.created_at, updatedAt: space.updated_at };
}

spacesRouter.post("/get-smart-spaces", requireAuth, (req, res) => reply(res, async () => {
  const { data, error } = await supabaseAdmin.from("smart_spaces").select("*").eq("owner_clerk_user_id", owner(req as AuthRequest)).order("sort_order").order("created_at");
  if (error) throw new Error(error.message);
  return Promise.all((data || []).map(serialize));
}));
spacesRouter.post("/create-smart-space", requireAuth, (req, res) => reply(res, async () => {
  const data = filters.extend({ title: z.string().min(1).max(80) }).parse(req.body);
  const { data: space, error } = await supabaseAdmin.from("smart_spaces").insert({ owner_clerk_user_id: owner(req as AuthRequest), title: data.title, icon: data.icon || "◆", color: data.color || "#2f9cf4", include_unread_only: data.includeUnreadOnly ?? false, include_direct: data.includeDirect ?? true, include_groups: data.includeGroups ?? true, include_channels: data.includeChannels ?? true }).select().single();
  if (error) throw new Error(error.message);
  return serialize(space);
}));
spacesRouter.post("/update-smart-space", requireAuth, (req, res) => reply(res, async () => {
  const data = filters.extend({ spaceId }).parse(req.body);
  await ownedSpace(req as AuthRequest, data.spaceId);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(data)) if (key !== "spaceId" && value !== undefined) updates[key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] = value;
  const { data: space, error } = await supabaseAdmin.from("smart_spaces").update(updates).eq("id", data.spaceId).eq("owner_clerk_user_id", owner(req as AuthRequest)).select().single();
  if (error) throw new Error(error.message);
  return serialize(space);
}));
spacesRouter.post("/delete-smart-space", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ spaceId }).parse(req.body);
  await ownedSpace(req as AuthRequest, data.spaceId);
  const { error } = await supabaseAdmin.from("smart_spaces").delete().eq("id", data.spaceId).eq("owner_clerk_user_id", owner(req as AuthRequest));
  if (error) throw new Error(error.message);
  return { success: true };
}));
spacesRouter.post("/add-smart-space-rule", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ spaceId, chatId: z.string().min(1).max(255), entityType: z.enum(["conversation", "channel"]).default("conversation"), ruleType: z.enum(["whitelist", "blacklist"]) }).parse(req.body);
  await ownedSpace(req as AuthRequest, data.spaceId);
  const opposite = data.ruleType === "whitelist" ? "blacklist" : "whitelist";
  await supabaseAdmin.from("smart_space_rules").delete().eq("space_id", data.spaceId).eq("chat_id", data.chatId).eq("entity_type", data.entityType).eq("rule_type", opposite);
  const { error } = await supabaseAdmin.from("smart_space_rules").upsert({ space_id: data.spaceId, chat_id: data.chatId, entity_type: data.entityType, rule_type: data.ruleType }, { onConflict: "space_id,chat_id,entity_type,rule_type" });
  if (error) throw new Error(error.message);
  return { success: true };
}));
spacesRouter.post("/remove-smart-space-rule", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ spaceId, chatId: z.string().min(1).max(255), entityType: z.enum(["conversation", "channel"]).optional(), ruleType: z.enum(["whitelist", "blacklist"]).optional() }).parse(req.body);
  await ownedSpace(req as AuthRequest, data.spaceId);
  let query = supabaseAdmin.from("smart_space_rules").delete().eq("space_id", data.spaceId).eq("chat_id", data.chatId);
  if (data.entityType) query = query.eq("entity_type", data.entityType);
  if (data.ruleType) query = query.eq("rule_type", data.ruleType);
  const { error } = await query;
  if (error) throw new Error(error.message);
  return { success: true };
}));
spacesRouter.post("/reorder-smart-spaces", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ items: z.array(z.object({ spaceId, sortOrder: z.number().int().min(0) })).max(100) }).parse(req.body);
  for (const item of data.items) { await ownedSpace(req as AuthRequest, item.spaceId); const { error } = await supabaseAdmin.from("smart_spaces").update({ sort_order: item.sortOrder, updated_at: new Date().toISOString() }).eq("id", item.spaceId).eq("owner_clerk_user_id", owner(req as AuthRequest)); if (error) throw new Error(error.message); }
  return { success: true };
}));

spacesRouter.post("/get-theme", requireAuth, (req, res) => reply(res, async () => {
  const { data, error } = await supabaseAdmin.from("user_preferences").select("theme").eq("clerk_user_id", owner(req as AuthRequest)).maybeSingle();
  if (error) throw new Error(error.message);
  return { theme: data?.theme || "chatgram" };
}));
spacesRouter.post("/update-theme", requireAuth, (req, res) => reply(res, async () => {
  const data = z.object({ theme: z.enum(["dark", "light", "chatgram"]) }).parse(req.body);
  const { data: preference, error } = await supabaseAdmin.from("user_preferences").upsert({ clerk_user_id: owner(req as AuthRequest), theme: data.theme, updated_at: new Date().toISOString() }, { onConflict: "clerk_user_id" }).select("theme").single();
  if (error) throw new Error(error.message);
  return preference;
}));
