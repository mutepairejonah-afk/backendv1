import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const premiumRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

premiumRouter.post("/get-premium-status", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: profile } = await supabaseAdmin.from("profiles").select("subscription_tier, hide_read_receipts, verified, bio_links, is_admin").eq("clerk_user_id", data.clerkUserId).single();
  const effectiveTier = profile?.is_admin ? "pro" : ((profile?.subscription_tier as string) ?? "free");
  return { tier: effectiveTier, isAdmin: profile?.is_admin === true, hideReadReceipts: profile?.hide_read_receipts ?? false, verified: profile?.verified ?? false, bioLinks: profile?.bio_links ?? [] };
}));

// NOTE: this sets the tier directly. Wire this up behind your actual billing
// provider (App Store/Play Store IAP or Stripe) — call this from your
// payment-succeeded webhook handler rather than letting the client invoke it
// directly, or an end user could grant themselves Premium for free.
premiumRouter.post("/upgrade-plan", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), tier: z.enum(["free", "premium", "pro"]) }).parse(req.body);
  const { error } = await supabaseAdmin.from("profiles").update({ subscription_tier: data.tier }).eq("clerk_user_id", data.clerkUserId);
  if (error) throw new Error(`Failed to update plan: ${error.message}`);
  return { success: true, tier: data.tier };
}));

premiumRouter.post("/update-privacy-settings", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), hideReadReceipts: z.boolean().optional() }).parse(req.body);
  const updates: Record<string, unknown> = {};
  if (data.hideReadReceipts !== undefined) updates.hide_read_receipts = data.hideReadReceipts;
  const { data: profile, error } = await supabaseAdmin.from("profiles").update(updates).eq("clerk_user_id", data.clerkUserId).select().single();
  if (error) throw new Error(`Failed to update privacy settings: ${error.message}`);
  return profile;
}));

premiumRouter.post("/update-bio-links", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), bioLinks: z.array(z.object({ label: z.string().max(60), url: z.string().url().max(500) })).max(5) }).parse(req.body);
  const { error } = await supabaseAdmin.from("profiles").update({ bio_links: data.bioLinks }).eq("clerk_user_id", data.clerkUserId);
  if (error) throw new Error(`Failed to update bio links: ${error.message}`);
  return { success: true };
}));

premiumRouter.post("/get-is-admin", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: profile } = await supabaseAdmin.from("profiles").select("is_admin").eq("clerk_user_id", data.clerkUserId).single();
  return { isAdmin: profile?.is_admin === true };
}));
