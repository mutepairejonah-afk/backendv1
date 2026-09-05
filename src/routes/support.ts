import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { checkRateLimit } from "../lib/rate-limit.js";

export const supportRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : (err?.status || 500);
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err?.message || "Internal server error") });
  }
};

const userId = (req: any) => (req as AuthRequest).clerkUserId;

async function assertConversationMember(conversationId: string, clerkUserId: string) {
  const { data, error } = await supabaseAdmin.from("conversation_members")
    .select("id, role").eq("conversation_id", conversationId).eq("clerk_user_id", clerkUserId).maybeSingle();
  if (error) throw new Error(`Failed to verify conversation access: ${error.message}`);
  if (!data) { const e = new Error("You are not a member of this conversation") as Error & { status?: number }; e.status = 403; throw e; }
  return data;
}

// ── Saved items (bookmarks) ──────────────────────────────────────────────────
supportRouter.post("/saved-items/create", requireAuth, (req, res) => rp(res, async () => {
  const clerkUserId = userId(req);
  const data = z.object({
    conversationId: z.string().uuid().optional(), messageId: z.string().uuid().optional(),
    content: z.string().max(8000).optional(), title: z.string().max(200).optional(), label: z.string().max(80).optional(),
  }).refine((v) => v.messageId || v.content?.trim(), "messageId or content is required").parse(req.body);
  if (data.conversationId) await assertConversationMember(data.conversationId, clerkUserId);
  let content = data.content?.trim() || null;
  if (data.messageId) {
    const { data: message, error } = await supabaseAdmin.from("messages").select("conversation_id, text, is_deleted").eq("id", data.messageId).maybeSingle();
    if (error) throw new Error(`Failed to load message: ${error.message}`);
    if (!message || message.is_deleted) throw new Error("Message not found");
    await assertConversationMember(message.conversation_id, clerkUserId);
    if (data.conversationId && data.conversationId !== message.conversation_id) throw new Error("Message does not belong to this conversation");
    content = content || (message.text ? String(message.text).slice(0, 8000) : null);
  }
  if (!content) throw new Error("Only text messages can be saved without custom content");
  const { data: row, error } = await supabaseAdmin.from("saved_items").insert({
    clerk_user_id: clerkUserId, conversation_id: data.conversationId || null, message_id: data.messageId || null,
    content, title: data.title?.trim() || null, label: data.label?.trim() || null,
  }).select().single();
  if (error) throw new Error(`Failed to save item: ${error.message}`);
  return row;
}));

supportRouter.post("/saved-items/list", requireAuth, (req, res) => rp(res, async () => {
  const clerkUserId = userId(req);
  const data = z.object({ label: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().datetime().optional() }).parse(req.body);
  let query = supabaseAdmin.from("saved_items").select("*").eq("clerk_user_id", clerkUserId).order("created_at", { ascending: false }).limit(data.limit ?? 50);
  if (data.label) query = query.eq("label", data.label);
  if (data.cursor) query = query.lt("created_at", data.cursor);
  const { data: rows, error } = await query;
  if (error) throw new Error(`Failed to list saved items: ${error.message}`);
  return rows ?? [];
}));

supportRouter.post("/saved-items/delete", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ id: z.string().uuid() }).parse(req.body);
  const { error } = await supabaseAdmin.from("saved_items").delete().eq("id", data.id).eq("clerk_user_id", userId(req));
  if (error) throw new Error(`Failed to delete saved item: ${error.message}`);
  return { success: true };
}));

// ── Authorized global search across message text ────────────────────────────
supportRouter.post("/search-messages", requireAuth, (req, res) => rp(res, async () => {
  const clerkUserId = userId(req);
  const data = z.object({ query: z.string().trim().min(2).max(100), conversationId: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).optional() }).parse(req.body);
  if (!checkRateLimit(`message-search:${clerkUserId}`, 60, 60_000)) throw new Error("Too many search requests. Please wait a moment.");
  let conversationIds: string[];
  if (data.conversationId) {
    await assertConversationMember(data.conversationId, clerkUserId);
    conversationIds = [data.conversationId];
  } else {
    const { data: memberships, error } = await supabaseAdmin.from("conversation_members").select("conversation_id").eq("clerk_user_id", clerkUserId).limit(1000);
    if (error) throw new Error(`Failed to load accessible conversations: ${error.message}`);
    conversationIds = (memberships ?? []).map((m: any) => m.conversation_id);
  }
  if (!conversationIds.length) return { results: [], query: data.query };
  const { data: rows, error } = await supabaseAdmin.from("messages")
    .select("id, conversation_id, sender_clerk_id, text, created_at, reply_to_message_id")
    .in("conversation_id", conversationIds).neq("is_deleted", true).not("text", "is", null)
    .ilike("text", `%${data.query}%`).order("created_at", { ascending: false }).limit(data.limit ?? 30);
  if (error) throw new Error(`Failed to search messages: ${error.message}`);
  return { query: data.query, results: rows ?? [] };
}));
