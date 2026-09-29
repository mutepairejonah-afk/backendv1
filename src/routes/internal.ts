import { Router } from "express";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { emitMomentCreated, emitMomentDeleted } from "../socket.js";

export const internalRouter = Router();

// Supabase Edge Functions have no Clerk session token to present (they act
// with the service-role key, not as a logged-in user), so this router uses a
// separate shared-secret check instead of requireAuth. It exists purely so
// that moved-to-Supabase endpoints (media uploads, in particular) can still
// ask the Render process -- the only place with live Socket.IO connections --
// to broadcast a realtime event after writing to the database.
function requireInternalSecret(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.INTERNAL_FUNCTIONS_SECRET;
  if (!configured) {
    // Refuse to expose this router at all if no secret is configured, rather
    // than silently accepting unauthenticated calls.
    res.status(503).json({ error: "Internal bridge is not configured" });
    return;
  }
  const provided = req.headers["x-internal-secret"];
  if (typeof provided !== "string" || provided !== configured) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

internalRouter.use(requireInternalSecret);

internalRouter.post("/internal/broadcast-moment-created", (req, res) => {
  const data = z.object({ momentId: z.string().uuid() }).safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "momentId is required" }); return; }
  emitMomentCreated(data.data.momentId);
  res.json({ success: true });
});

internalRouter.post("/internal/broadcast-moment-deleted", (req, res) => {
  const data = z.object({ momentId: z.string().uuid() }).safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "momentId is required" }); return; }
  emitMomentDeleted(data.data.momentId);
  res.json({ success: true });
});
