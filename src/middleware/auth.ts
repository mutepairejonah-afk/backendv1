import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "@clerk/backend";
import { getClientIp, logSecurityEvent } from "../lib/security.js";
import { checkRateLimit } from "../lib/rate-limit.js";

export interface AuthRequest extends Request {
  clerkUserId: string;
}

function recordAuthFailure(req: Request, reason: string) {
  const ip = getClientIp(req);
  if (checkRateLimit(`auth-failure-log:${ip}`, 10, 60_000)) {
    void logSecurityEvent({ eventType: "auth.failed", severity: "warning", ip, userAgent: req.headers["user-agent"] as string, metadata: { reason, path: req.path } });
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    recordAuthFailure(req, "missing_bearer_token");
    res.status(401).json({ error: "Unauthorized: missing Bearer token" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    (req as AuthRequest).clerkUserId = payload.sub;
    // Override body clerkUserId with the verified one so handlers can trust req.body.clerkUserId
    if (req.body && typeof req.body === "object") {
      req.body.clerkUserId = payload.sub;
    }
    next();
  } catch (err: any) {
    recordAuthFailure(req, "invalid_bearer_token");
    res.status(401).json({ error: "Unauthorized: invalid token" });
  }
}

/** Optional auth: populates clerkUserId if token present, but doesn't reject anonymous requests */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = await verifyToken(authHeader.slice(7), {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      (req as AuthRequest).clerkUserId = payload.sub;
      if (req.body && typeof req.body === "object") {
        req.body.clerkUserId = payload.sub;
      }
    } catch {
      // ignore auth errors for optional routes
    }
  }
  next();
}
