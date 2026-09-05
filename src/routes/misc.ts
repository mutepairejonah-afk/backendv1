import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const miscRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

// Block/Report
miscRouter.post("/block-user", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), targetClerkId: z.string().min(1).max(255) }).parse(req.body);
  if (data.clerkUserId === data.targetClerkId) throw new Error("You cannot block yourself");
  await supabaseAdmin.from("blocked_users").upsert({ blocker_clerk_id: data.clerkUserId, blocked_clerk_id: data.targetClerkId }, { onConflict: "blocker_clerk_id,blocked_clerk_id" });
  await supabaseAdmin.from("contacts").delete().eq("user_clerk_id", data.clerkUserId).eq("contact_clerk_id", data.targetClerkId);
  await supabaseAdmin.from("contacts").delete().eq("user_clerk_id", data.targetClerkId).eq("contact_clerk_id", data.clerkUserId);
  return { success: true };
}));

miscRouter.post("/unblock-user", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), targetClerkId: z.string().min(1).max(255) }).parse(req.body);
  await supabaseAdmin.from("blocked_users").delete().eq("blocker_clerk_id", data.clerkUserId).eq("blocked_clerk_id", data.targetClerkId);
  return { success: true };
}));

miscRouter.post("/get-blocked-users", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: rows } = await supabaseAdmin.from("blocked_users").select("blocked_clerk_id, created_at").eq("blocker_clerk_id", data.clerkUserId);
  if (!rows?.length) return [];
  const ids = rows.map((r: any) => r.blocked_clerk_id);
  const { data: profs } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, avatar_url, username").in("clerk_user_id", ids);
  return rows.map((r: any) => ({ ...r, profile: profs?.find((p: any) => p.clerk_user_id === r.blocked_clerk_id) || null }));
}));

miscRouter.post("/is-blocked", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), targetClerkId: z.string().min(1).max(255) }).parse(req.body);
  const { data: row } = await supabaseAdmin.from("blocked_users").select("id").eq("blocker_clerk_id", data.clerkUserId).eq("blocked_clerk_id", data.targetClerkId).maybeSingle();
  return { blocked: !!row };
}));

miscRouter.post("/report-target", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), targetType: z.enum(["user", "group", "message"]), targetId: z.string().min(1).max(255), reason: z.string().min(1).max(1000) }).parse(req.body);
  const { error } = await supabaseAdmin.from("reports").insert({ reporter_clerk_id: data.clerkUserId, target_type: data.targetType, target_id: data.targetId, reason: data.reason });
  if (error) throw new Error(`Failed to submit report: ${error.message}`);
  return { success: true };
}));

// Compatibility endpoint for the frontend's feature/setup readiness check.
// Database migrations are shipped with this backend, so this reports the
// feature set supported by the current API rather than exposing schema details.
miscRouter.post("/get-setup-status", requireAuth, (req, res) => rp(res, async () => {
  z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  return {
    usernameApplied: true,
    friendRequestsApplied: true,
    messageEditDeleteReplyApplied: true,
    callsApplied: true,
    momentsApplied: true,
    channelsApplied: true,
    groupFeaturesApplied: true,
    premiumApplied: true,
    pushTokenApplied: true,
    savedItemsApplied: true,
  };
}));
