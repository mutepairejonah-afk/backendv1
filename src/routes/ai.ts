import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  aiGenerate,
  aiChatReply,
  aiConversationBrief,
  aiDraftOrderReply,
  aiDraftSupportReply,
  aiReviewSupportMessage,
  aiSummarizeCallTranscript,
  aiSummarizeUnread,
  aiTranslateText,
} from "../lib/ai.js";
import type { AuthRequest } from "../middleware/auth.js";

export const aiRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try {
    res.json(await fn());
  } catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : (err?.status || 500);
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err?.message || "Internal server error") });
  }
};

const copilotInput = z.object({
  conversationId: z.string().uuid(),
  messageLimit: z.number().int().min(10).max(100).optional(),
});

async function loadCopilotContext(conversationId: string, clerkUserId: string, messageLimit = 40) {
  const { data: membership, error: membershipError } = await supabaseAdmin
    .from("conversation_members")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("clerk_user_id", clerkUserId)
    .maybeSingle();
  if (membershipError) throw new Error(`Failed to verify conversation access: ${membershipError.message}`);
  if (!membership) {
    const error = new Error("You are not a member of this conversation") as Error & { status?: number };
    error.status = 403;
    throw error;
  }
  const { data: rows, error } = await supabaseAdmin
    .from("messages")
    .select("sender_clerk_id, text, created_at, is_deleted")
    .eq("conversation_id", conversationId)
    .neq("is_deleted", true)
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(messageLimit);
  if (error) throw new Error(`Failed to load conversation messages: ${error.message}`);
  const labels = new Map<string, string>();
  (rows ?? []).slice().reverse().forEach((row: any) => {
    if (!labels.has(row.sender_clerk_id)) labels.set(row.sender_clerk_id, `Participant ${labels.size + 1}`);
  });
  return (rows ?? []).slice().reverse().map((row: any) => ({
    sender: labels.get(row.sender_clerk_id) || "Participant",
    text: String(row.text).slice(0, 1600),
    createdAt: row.created_at || null,
  }));
}

async function getTier(clerkUserId: string) {
  const { data: profile } = await supabaseAdmin.from("profiles").select("subscription_tier, is_admin").eq("clerk_user_id", clerkUserId).maybeSingle();
  return profile?.is_admin ? "pro" : (profile?.subscription_tier || "free");
}

/**
 * Creates a private, on-demand brief of a conversation for the authenticated member.
 * The endpoint does not persist the transcript or AI output.
 */
aiRouter.post("/ai/conversation-brief", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    conversationId: z.string().uuid(),
    messageLimit: z.number().int().min(10).max(100).optional(),
  }).parse(req.body);

  if (!checkRateLimit(`ai-brief:${data.clerkUserId}`, 5, 60_000)) {
    throw new Error("Too many AI brief requests. Please wait a moment.");
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from("conversation_members")
    .select("id")
    .eq("conversation_id", data.conversationId)
    .eq("clerk_user_id", data.clerkUserId)
    .maybeSingle();
  if (membershipError) throw new Error(`Failed to verify conversation access: ${membershipError.message}`);
  if (!membership) {
    const error = new Error("You are not a member of this conversation") as Error & { status?: number };
    error.status = 403;
    throw error;
  }

  const limit = data.messageLimit ?? 80;
  const { data: rows, error: messagesError } = await supabaseAdmin
    .from("messages")
    .select("sender_clerk_id, text, created_at, is_deleted")
    .eq("conversation_id", data.conversationId)
    .neq("is_deleted", true)
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (messagesError) throw new Error(`Failed to load conversation messages: ${messagesError.message}`);

  const participantLabels = new Map<string, string>();
  (rows ?? []).slice().reverse().forEach((row: any) => {
    if (!participantLabels.has(row.sender_clerk_id)) {
      participantLabels.set(row.sender_clerk_id, `Participant ${participantLabels.size + 1}`);
    }
  });

  const messages = (rows ?? []).slice().reverse().map((row: any) => ({
    sender: participantLabels.get(row.sender_clerk_id) || "Participant",
    text: String(row.text).slice(0, 1200),
    createdAt: row.created_at || null,
  }));

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("subscription_tier, is_admin")
    .eq("clerk_user_id", data.clerkUserId)
    .maybeSingle();
  const tier = profile?.is_admin ? "pro" : (profile?.subscription_tier || "free");
  const brief = await aiConversationBrief(messages, tier);

  return {
    conversationId: data.conversationId,
    sourceMessageCount: messages.length,
    generatedAt: new Date().toISOString(),
    brief,
  };
}));

/** Drafts a reply for a human agent. It never sends or persists a message. */
aiRouter.post("/ai/draft-reply", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = copilotInput.extend({
    tone: z.enum(["professional", "warm", "concise", "empathetic", "firm"]).default("professional"),
    goal: z.string().max(500).optional(),
    policy: z.string().max(2500).optional(),
  }).parse(req.body);
  if (!checkRateLimit(`ai-draft:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many copilot requests. Please wait a moment.");
  const messages = await loadCopilotContext(data.conversationId, authReq.clerkUserId, data.messageLimit ?? 40);
  const draft = await aiDraftSupportReply(messages, { tone: data.tone, goal: data.goal, policy: data.policy }, await getTier(authReq.clerkUserId));
  return { conversationId: data.conversationId, draft, generatedAt: new Date().toISOString(), requiresHumanApproval: true };
}));

/** Reviews a proposed reply against a private conversation context. It never sends anything. */
aiRouter.post("/ai/review-message", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = copilotInput.extend({ draft: z.string().min(1).max(2000) }).parse(req.body);
  if (!checkRateLimit(`ai-review:${authReq.clerkUserId}`, 5, 60_000)) throw new Error("Too many review requests. Please wait a moment.");
  const messages = await loadCopilotContext(data.conversationId, authReq.clerkUserId, data.messageLimit ?? 40);
  const review = await aiReviewSupportMessage(data.draft, messages, await getTier(authReq.clerkUserId));
  return { conversationId: data.conversationId, review, generatedAt: new Date().toISOString(), requiresHumanApproval: true };
}));

// Legacy/simple AI endpoints used by the web and Capacitor clients.
// They remain behind Clerk auth so API keys never reach the device.
aiRouter.post("/ai-chat-assist", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    question: z.string().trim().min(1).max(4000),
    recentMessages: z.array(z.object({ sender: z.string().max(100), text: z.string().max(2000) })).max(20).optional(),
  }).parse(req.body);
  if (!checkRateLimit(`ai-chat:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many AI requests. Please wait a moment.");
  return { reply: await aiChatReply(data.question, data.recentMessages ?? [], await getTier(authReq.clerkUserId)) };
}));

aiRouter.post("/translate-message", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = z.object({ clerkUserId: z.string().min(1).max(255), text: z.string().trim().min(1).max(5000), targetLanguage: z.string().trim().min(2).max(80) }).parse(req.body);
  if (!checkRateLimit(`ai-translate:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many AI requests. Please wait a moment.");
  return { translated: await aiTranslateText(data.text, data.targetLanguage, await getTier(authReq.clerkUserId)) };
}));

aiRouter.post("/ai-summarize-unread", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = z.object({
    clerkUserId: z.string().min(1).max(255), channelName: z.string().max(120),
    messages: z.array(z.object({ sender: z.string().max(100), text: z.string().max(2000), timestamp: z.string().max(80) })).max(100),
  }).parse(req.body);
  if (!checkRateLimit(`ai-summary:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many AI requests. Please wait a moment.");
  return { summary: await aiSummarizeUnread(data.channelName, data.messages, await getTier(authReq.clerkUserId)) };
}));

aiRouter.post("/ai-draft-order-reply", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = z.object({ clerkUserId: z.string().min(1).max(255), context: z.enum(["order_confirmation", "out_of_hours", "order_status_update"]), details: z.record(z.unknown()).optional() }).parse(req.body);
  if (!checkRateLimit(`ai-order:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many AI requests. Please wait a moment.");
  return { draft: await aiDraftOrderReply(data.context, data.details ?? {}, await getTier(authReq.clerkUserId)) };
}));

aiRouter.post("/ai-summarize-call", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = z.object({ clerkUserId: z.string().min(1).max(255), transcript: z.array(z.object({ speaker: z.string().max(100), text: z.string().max(3000) })).max(500) }).parse(req.body);
  if (!checkRateLimit(`ai-call-summary:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many AI requests. Please wait a moment.");
  return { notes: await aiSummarizeCallTranscript(data.transcript, await getTier(authReq.clerkUserId)) };
}));

/** Generates concise smart-reply options; the client must let the user edit before sending. */
aiRouter.post("/ai/smart-replies", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = z.object({
    conversationId: z.string().uuid(),
    message: z.string().trim().min(1).max(3000),
    count: z.number().int().min(1).max(5).optional(),
  }).parse(req.body);
  if (!checkRateLimit(`ai-smart-replies:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many AI requests. Please wait a moment.");
  const count = data.count ?? 3;
  const raw = await aiGenerate(
    `Create ${count} short, natural reply options to this message. Return one option per line, without numbering or commentary. Message: ${data.message}`,
    "You generate safe, concise message suggestions. Never claim to have taken an action. Never include harmful or discriminatory content.",
    await getTier(authReq.clerkUserId),
  );
  return { conversationId: data.conversationId, replies: raw.split(/\n+/).map((line) => line.replace(/^[-*\d.) ]+/, "").trim()).filter(Boolean).slice(0, count) };
}));

/** Extracts reviewable action items from a call or conversation transcript. */
aiRouter.post("/ai/action-items", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = z.object({
    source: z.enum(["conversation", "call"]),
    transcript: z.array(z.object({ speaker: z.string().max(100), text: z.string().trim().min(1).max(3000) })).min(1).max(500),
  }).parse(req.body);
  if (!checkRateLimit(`ai-action-items:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many AI requests. Please wait a moment.");
  const transcript = data.transcript.map((item) => `${item.speaker}: ${item.text}`).join("\n");
  const items = await aiGenerate(
    `Extract concrete action items from this ${data.source}. Return one item per line. If none exist, return "No action items found." Do not invent owners or deadlines.\n\n${transcript}`,
    "You extract only explicit or strongly implied tasks. Keep output concise and do not expose private data beyond the supplied text.",
    await getTier(authReq.clerkUserId),
  );
  return { source: data.source, items: items.split(/\n+/).map((line) => line.replace(/^[-*\d.) ]+/, "").trim()).filter(Boolean).slice(0, 50) };
}));

/** Creates a draft public channel description; it never publishes changes. */
aiRouter.post("/ai/channel-description", requireAuth, (req, res) => rp(res, async () => {
  const authReq = req as AuthRequest;
  const data = z.object({
    topic: z.string().trim().min(2).max(500),
    tone: z.enum(["professional", "friendly", "concise"]).default("friendly"),
  }).parse(req.body);
  if (!checkRateLimit(`ai-channel-description:${authReq.clerkUserId}`, 10, 60_000)) throw new Error("Too many AI requests. Please wait a moment.");
  const description = await aiGenerate(
    `Write one clear public channel description under 300 characters for this topic: ${data.topic}. Tone: ${data.tone}. Return only the description.`,
    "You write safe, accurate social channel descriptions. Do not make unverifiable promises or include spam.",
    await getTier(authReq.clerkUserId),
  );
  return { description: description.trim().slice(0, 300) };
}));
