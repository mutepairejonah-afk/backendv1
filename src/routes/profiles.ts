import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const profilesRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

profilesRouter.post("/get-or-create-profile", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    displayName: z.string().min(1).max(255).optional(),
    avatarUrl: z.string().url().max(2048).optional(),
  }).parse(req.body);

  const { data: existing } = await supabaseAdmin.from("profiles").select("*").eq("clerk_user_id", data.clerkUserId).single();
  if (existing) return existing;

  const { data: profile, error } = await supabaseAdmin.from("profiles").insert({
    clerk_user_id: data.clerkUserId,
    display_name: data.displayName || null,
    avatar_url: data.avatarUrl || null,
    is_online: true,
  }).select().single();
  if (error) throw new Error(`Failed to create profile: ${error.message}`);
  return profile;
}));

profilesRouter.post("/update-profile", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    displayName: z.string().min(1).max(255).optional(),
    avatarUrl: z.string().url().max(2048).optional(),
    statusMessage: z.string().max(500).optional(),
    isOnline: z.boolean().optional(),
  }).parse(req.body);

  const updates: Record<string, any> = {};
  if (data.displayName !== undefined) updates.display_name = data.displayName;
  if (data.avatarUrl !== undefined) updates.avatar_url = data.avatarUrl;
  if (data.statusMessage !== undefined) updates.status_message = data.statusMessage;
  if (data.isOnline !== undefined) {
    updates.is_online = data.isOnline;
    if (!data.isOnline) updates.last_seen = new Date().toISOString();
  }

  const { data: profile, error } = await supabaseAdmin.from("profiles").update(updates).eq("clerk_user_id", data.clerkUserId).select().single();
  if (error) throw new Error(`Failed to update profile: ${error.message}`);
  return profile;
}));

profilesRouter.post("/get-all-profiles", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: profiles, error } = await supabaseAdmin.from("profiles").select("*").neq("clerk_user_id", data.clerkUserId).order("display_name", { ascending: true });
  if (error) throw new Error(`Failed to get profiles: ${error.message}`);
  return profiles || [];
}));

profilesRouter.post("/check-username-availability", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
    clerkUserId: z.string().min(1).max(255),
  }).parse(req.body);
  const { data: existing } = await supabaseAdmin.from("profiles").select("clerk_user_id").ilike("username", data.username).single();
  if (!existing) return { available: true };
  if (existing.clerk_user_id === data.clerkUserId) return { available: true };
  return { available: false };
}));

profilesRouter.post("/claim-username", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
  }).parse(req.body);
  const { data: existing } = await supabaseAdmin.from("profiles").select("clerk_user_id").ilike("username", data.username).single();
  if (existing && existing.clerk_user_id !== data.clerkUserId) throw new Error("Username is already taken");
  const { data: profile, error } = await supabaseAdmin.from("profiles").update({ username: data.username.toLowerCase() }).eq("clerk_user_id", data.clerkUserId).select().single();
  if (error) throw new Error(`Failed to claim username: ${error.message}`);
  return profile;
}));

profilesRouter.post("/get-profile-by-username", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ username: z.string().min(1).max(30) }).parse(req.body);
  const { data: profile } = await supabaseAdmin.from("profiles").select("*").ilike("username", data.username).single();
  return profile || null;
}));

profilesRouter.post("/get-profile-by-clerk-id", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: profile } = await supabaseAdmin.from("profiles").select("*").eq("clerk_user_id", data.clerkUserId).single();
  return profile || null;
}));

profilesRouter.post("/search-profiles-by-username", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ query: z.string().min(1).max(50), clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const clean = data.query.replace(/^@/, "").toLowerCase();
  const { data: profiles } = await supabaseAdmin.from("profiles").select("*").ilike("username", `${clean}%`).neq("clerk_user_id", data.clerkUserId).limit(10);
  return profiles || [];
}));
