import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { requireAuth } from "../middleware/auth.js";

export const callsRouter = Router();

const rp = async (res: any, fn: () => Promise<any>) => {
  try { res.json(await fn()); }
  catch (err: any) {
    const status = err?.name === "ZodError" ? 400 : 500;
    res.status(status).json({ error: process.env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : (err.message || "Internal server error") });
  }
};

callsRouter.post("/log-call", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ conversationId: z.string().uuid(), callerClerkId: z.string().min(1).max(255), calleeClerkId: z.string().min(1).max(255), kind: z.enum(["audio", "video"]), status: z.enum(["answered", "missed", "rejected", "cancelled"]), durationSeconds: z.number().int().min(0).default(0), startedAt: z.string().optional() }).parse(req.body);
  const startedAt = data.startedAt || new Date().toISOString();
  const { data: row, error } = await supabaseAdmin.from("call_logs").insert({ conversation_id: data.conversationId, caller_clerk_id: data.callerClerkId, callee_clerk_id: data.calleeClerkId, kind: data.kind, status: data.status, duration_seconds: data.durationSeconds, started_at: startedAt, ended_at: new Date().toISOString() }).select("*").single();
  if (error) { console.error("logCall failed:", error); return null; }
  return row;
}));

callsRouter.post("/get-call-history", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { data: rows, error } = await supabaseAdmin.from("call_logs").select("*").or(`caller_clerk_id.eq.${data.clerkUserId},callee_clerk_id.eq.${data.clerkUserId}`).order("started_at", { ascending: false }).limit(150);
  if (error) return [];
  if (!rows || rows.length === 0) return [];
  const peerIds = Array.from(new Set(rows.map((r: any) => r.caller_clerk_id === data.clerkUserId ? r.callee_clerk_id : r.caller_clerk_id)));
  const { data: profs } = await supabaseAdmin.from("profiles").select("clerk_user_id, display_name, avatar_url, username").in("clerk_user_id", peerIds);
  const byId = new Map((profs || []).map((p: any) => [p.clerk_user_id, p]));
  return rows.map((r: any) => {
    const peerClerkId = r.caller_clerk_id === data.clerkUserId ? r.callee_clerk_id : r.caller_clerk_id;
    return { ...r, direction: r.caller_clerk_id === data.clerkUserId ? "outgoing" : "incoming", peerClerkId, peerProfile: byId.get(peerClerkId) || null };
  });
}));

callsRouter.post("/delete-call-log", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ callLogId: z.string().uuid(), clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { error } = await supabaseAdmin.from("call_logs").delete().eq("id", data.callLogId).or(`caller_clerk_id.eq.${data.clerkUserId},callee_clerk_id.eq.${data.clerkUserId}`);
  if (error) throw new Error(error.message);
  return { success: true };
}));

callsRouter.post("/clear-call-history", requireAuth, (req, res) => rp(res, async () => {
  const data = z.object({ clerkUserId: z.string().min(1).max(255) }).parse(req.body);
  const { error } = await supabaseAdmin.from("call_logs").delete().or(`caller_clerk_id.eq.${data.clerkUserId},callee_clerk_id.eq.${data.clerkUserId}`);
  if (error) throw new Error(error.message);
  return { success: true };
}));

callsRouter.post("/get-ice-servers", requireAuth, (req, res) => rp(res, async () => {
  const stun = [{ urls: "stun:stun.relay.metered.ca:80" }, { urls: "stun:stun.l.google.com:19302" }];
  const xirsysIdent = process.env.XIRSYS_IDENT?.trim();
  const xirsysSecret = process.env.XIRSYS_SECRET?.trim();
  const xirsysChannel = process.env.XIRSYS_CHANNEL?.trim();
  if (xirsysIdent && xirsysSecret && xirsysChannel) {
    const auth = Buffer.from(`${xirsysIdent}:${xirsysSecret}`).toString("base64");
    const response = await fetch(`https://global.xirsys.net/_turn/${encodeURIComponent(xirsysChannel)}?webrtc=1&expire=3600`, { method: "PUT", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }, body: "{}" });
    const payload = await response.json() as { s?: string; v?: { iceServers?: RTCIceServer[] } };
    if (!response.ok || payload.s !== "ok" || !payload.v?.iceServers?.length) throw new Error("Xirsys TURN request failed");
    return { iceServers: payload.v.iceServers };
  }
  const secret = process.env.TURN_SECRET;
  const explicitTurnUrls = process.env.TURN_URLS;
  const turnHost = process.env.TURN_PUBLIC_HOST;
  const turnPort = process.env.TURN_PORT || "3478";
  const turnUrlsRaw = explicitTurnUrls?.trim() ? explicitTurnUrls : turnHost ? `turn:${turnHost}:${turnPort},turn:${turnHost}:${turnPort}?transport=tcp` : undefined;
  if (secret && turnUrlsRaw) {
    const ttl = parseInt(process.env.TURN_TTL_SECONDS || "3600", 10);
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:webrtc`;
    const { createHmac } = await import("node:crypto");
    const password = createHmac("sha1", secret).update(username).digest("base64");
    const turnUrls = turnUrlsRaw.split(",").map((u: string) => u.trim()).filter(Boolean);
    return { iceServers: [...stun, { urls: turnUrls, username, credential: password }] };
  }
  const meteredUsername = process.env.TURN_USERNAME;
  const meteredCredential = process.env.TURN_CREDENTIAL;
  if (meteredUsername && meteredCredential) {
    return { iceServers: [...stun, { urls: "turn:standard.relay.metered.ca:80", username: meteredUsername, credential: meteredCredential }, { urls: "turn:standard.relay.metered.ca:80?transport=tcp", username: meteredUsername, credential: meteredCredential }, { urls: "turn:standard.relay.metered.ca:443", username: meteredUsername, credential: meteredCredential }, { urls: "turns:standard.relay.metered.ca:443?transport=tcp", username: meteredUsername, credential: meteredCredential }] };
  }
  return { iceServers: stun };
}));
