import type { Request, Response, NextFunction } from "express";
import { checkRateLimit } from "./rate-limit.js";
import { supabaseAdmin } from "./supabase.js";

export function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

export async function logSecurityEvent(opts: {
  clerkUserId?: string | null;
  eventType: string;
  severity?: "info" | "warning" | "critical";
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabaseAdmin.from("security_events").insert({
      clerk_user_id: opts.clerkUserId || null,
      event_type: opts.eventType,
      severity: opts.severity || "info",
      ip_address: opts.ip || null,
      user_agent: opts.userAgent || null,
      metadata: opts.metadata || {},
    });
  } catch (err) {
    console.error("[security] failed to log security event:", err);
  }
}

/**
 * Global, generous rate limit applied to every /api request, keyed by IP.
 * This is a coarse net-cast defense against scripted abuse; sensitive
 * routes (auth, invites, exports) should layer a tighter limit on top via
 * `sensitiveRateLimit` below.
 */
export function globalRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = getClientIp(req);
  if (!checkRateLimit(`global:${ip}`, 300, 60_000)) {
    logSecurityEvent({ eventType: "ratelimit.exceeded", severity: "warning", ip, userAgent: req.headers["user-agent"] as string, metadata: { path: req.path } });
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }
  next();
}

/** Tighter limit for a specific sensitive route (auth-adjacent, exports, invites). */
export function sensitiveRateLimit(name: string, maxReqs: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);
    if (!checkRateLimit(`${name}:${ip}`, maxReqs, windowMs)) {
      logSecurityEvent({ eventType: "ratelimit.exceeded", severity: "warning", ip, userAgent: req.headers["user-agent"] as string, metadata: { route: name } });
      return res.status(429).json({ error: "Too many requests to this endpoint. Please wait and try again." });
    }
    next();
  };
}

