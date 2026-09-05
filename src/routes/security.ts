import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";
import { getClientIp, logSecurityEvent, sensitiveRateLimit } from "../lib/security.js";

export const securityRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

// ── Personal privacy & security settings (Telegram's "Privacy and Security"
//    screen: two-step verification, active-sessions timeout, login alerts) ──
securityRouter.post("/get-security-settings", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: settings } = await supabaseAdmin.from("security_settings").select("*").eq("clerk_user_id", data.clerkUserId).maybeSingle();
  return settings || { clerk_user_id: data.clerkUserId, two_step_enabled: false, login_alerts_enabled: true, session_timeout_minutes: 10080 };
}));

securityRouter.post("/update-security-settings", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({
    clerkUserId: z.string().min(1).max(255),
    twoStepEnabled: z.boolean().optional(),
    loginAlertsEnabled: z.boolean().optional(),
    sessionTimeoutMinutes: z.number().min(5).max(525600).optional(),
  }).parse(req.body);

  const patch: Record<string, unknown> = { clerk_user_id: data.clerkUserId, updated_at: new Date().toISOString() };
  if (data.twoStepEnabled !== undefined) patch.two_step_enabled = data.twoStepEnabled;
  if (data.loginAlertsEnabled !== undefined) patch.login_alerts_enabled = data.loginAlertsEnabled;
  if (data.sessionTimeoutMinutes !== undefined) patch.session_timeout_minutes = data.sessionTimeoutMinutes;

  const { data: row, error } = await supabaseAdmin.from("security_settings").upsert(patch, { onConflict: "clerk_user_id" }).select().single();
  if (error) throw new Error(`Failed to update security settings: ${error.message}`);

  await logSecurityEvent({ clerkUserId: data.clerkUserId, eventType: "security.settings_changed", severity: "warning", ip: getClientIp(req), userAgent: req.headers["user-agent"] as string, metadata: patch });
  return row;
}));

// ── My sessions / devices ────────────────────────────────────────────────────
securityRouter.post("/register-session", requireAuth, (req, res) => rp(res, async () => {
  // Call this once on login from the frontend with a Clerk session id, so we
  // have a record to show/revoke in "Active devices". Best-effort — not a
  // security boundary by itself (Clerk owns the actual session validity).
  const data = z.object({ clerkUserId: z.string().min(1).max(255), clerkSessionId: z.string().min(1).max(255), deviceLabel: z.string().max(200).optional() }).parse(req.body);
  const ip = getClientIp(req);
  const userAgent = (req.headers["user-agent"] as string) || null;

  const { data: existingSessions } = await supabaseAdmin.from("user_sessions").select("id, ip_address").eq("clerk_user_id", data.clerkUserId).eq("is_active", true).order("created_at", { ascending: false }).limit(20);
  const isNewDevice = !(existingSessions || []).some((s: any) => s.ip_address === ip);

  const { data: row, error } = await supabaseAdmin.from("user_sessions").upsert(
    { clerk_user_id: data.clerkUserId, clerk_session_id: data.clerkSessionId, ip_address: ip, user_agent: userAgent, device_label: data.deviceLabel || null, is_active: true, last_seen_at: new Date().toISOString() },
    { onConflict: "clerk_session_id" }
  ).select().single();
  if (error) throw new Error(`Failed to register session: ${error.message}`);

  if (isNewDevice) {
    const { data: settings } = await supabaseAdmin.from("security_settings").select("login_alerts_enabled").eq("clerk_user_id", data.clerkUserId).maybeSingle();
    if (settings?.login_alerts_enabled !== false) {
      await logSecurityEvent({ clerkUserId: data.clerkUserId, eventType: "login.new_device", severity: "info", ip, userAgent: userAgent || undefined });
    }
  }
  return row;
}));

securityRouter.post("/get-my-sessions", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: sessions } = await supabaseAdmin.from("user_sessions").select("*").eq("clerk_user_id", data.clerkUserId).eq("is_active", true).order("last_seen_at", { ascending: false });
  return sessions || [];
}));

securityRouter.post("/revoke-session", requireAuth, sensitiveRateLimit("revoke-session", 20, 60_000), (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), sessionId: z.string().uuid() }).parse(req.body);
  const { data: session } = await supabaseAdmin.from("user_sessions").select("clerk_user_id").eq("id", data.sessionId).single();
  if (!session || session.clerk_user_id !== data.clerkUserId) throw new Error("Session not found");
  await supabaseAdmin.from("user_sessions").update({ is_active: false, revoked_at: new Date().toISOString() }).eq("id", data.sessionId);
  // NOTE: this marks OUR record revoked. To actually kill the Clerk session
  // token, call Clerk's backend SDK `clerkClient.sessions.revokeSession(id)`
  // here as well — left as a follow-up once CLERK_SECRET_KEY scopes are
  // confirmed for session management on your Clerk plan.
  await logSecurityEvent({ clerkUserId: data.clerkUserId, eventType: "session.revoked", severity: "info", ip: getClientIp(req) });
  return { success: true };
}));

// ── My security event feed (own login/device history only) ──────────────────
securityRouter.post("/get-security-events", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255), severity: z.enum(["info", "warning", "critical"]).optional(), limit: z.number().min(1).max(200).optional() }).parse(req.body);
  let query = supabaseAdmin.from("security_events").select("*").eq("clerk_user_id", data.clerkUserId).order("created_at", { ascending: false }).limit(data.limit || 100);
  if (data.severity) query = query.eq("severity", data.severity);
  const { data: events } = await query;
  return events || [];
}));
