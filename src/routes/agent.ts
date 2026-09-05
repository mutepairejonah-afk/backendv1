import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { runCommunicationAgent } from "../lib/agent.js";

export const agentRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : (err?.status || 500);
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err?.message || "Internal server error") });
  }
};

agentRouter.post("/ai/agent", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) })).min(1).max(12),
  }).parse(req.body);
  if (!checkRateLimit(`ai-agent:${data.clerkUserId}`, 20, 60_000)) {
    throw new Error("Too many agent requests. Please wait a moment.");
  }
  const { data: profile } = await supabaseAdmin.from("profiles").select("subscription_tier, is_admin").eq("clerk_user_id", data.clerkUserId).maybeSingle();
  const tier = profile?.is_admin ? "pro" : (profile?.subscription_tier || "free");
  const result = await runCommunicationAgent(data.messages, { clerkUserId: data.clerkUserId }, tier);
  return { reply: result.reply, toolCalls: result.toolCalls, generatedAt: new Date().toISOString() };
}));
