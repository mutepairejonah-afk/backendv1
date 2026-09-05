import { Router } from "express";
import express from "express";
import { Webhook } from "svix";
import { supabaseAdmin } from "../lib/supabase.js";
import { logSecurityEvent } from "../lib/security.js";

export const webhooksRouter = Router();

/**
 * Clerk webhook endpoint. MUST receive the raw request body (not JSON-parsed)
 * for signature verification to work — this router uses express.raw() itself
 * so it's safe to mount before or after the global express.json() middleware.
 *
 * Configure in the Clerk dashboard: Webhooks -> Add endpoint
 *   URL: https://<your-backend>/webhooks/clerk
 *   Events: session.created, session.ended, session.removed, user.created
 * Copy the signing secret into CLERK_WEBHOOK_SECRET.
 */
webhooksRouter.post("/clerk", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhooks] CLERK_WEBHOOK_SECRET not set — rejecting webhook");
    return res.status(500).json({ error: "Webhook not configured" });
  }

  const svixId = req.headers["svix-id"] as string;
  const svixTimestamp = req.headers["svix-timestamp"] as string;
  const svixSignature = req.headers["svix-signature"] as string;
  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({ error: "Missing svix headers" });
  }

  let event: any;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(req.body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch (err: any) {
    console.warn("[webhooks] Clerk signature verification failed:", err?.message);
    await logSecurityEvent({ eventType: "webhook.invalid_signature", severity: "critical", metadata: { source: "clerk" } });
    return res.status(400).json({ error: "Invalid signature" });
  }

  const { error: claimError } = await supabaseAdmin.from("webhook_events").insert({ id: svixId, provider: "clerk", event_type: event.type || "unknown", payload: event });
  if (claimError) {
    if (claimError.code === "23505") {
      const { data: existing } = await supabaseAdmin.from("webhook_events").select("processed_at").eq("id", svixId).maybeSingle();
      if (existing?.processed_at) return res.json({ received: true, duplicate: true });
      // A previous instance may have died after claiming but before processing.
      // Release that stale claim so this verified retry can process the event.
      await supabaseAdmin.from("webhook_events").delete().eq("id", svixId);
      const { error: retryClaimError } = await supabaseAdmin.from("webhook_events").insert({ id: svixId, provider: "clerk", event_type: event.type || "unknown", payload: event });
      if (!retryClaimError) {
        // Continue with normal processing below.
      } else {
        console.error("[webhooks] failed to reclaim Clerk event:", retryClaimError);
        return res.status(503).json({ error: "Webhook temporarily unavailable" });
      }
    }
    if (claimError.code !== "23505") {
      console.error("[webhooks] failed to claim Clerk event:", claimError);
      return res.status(503).json({ error: "Webhook temporarily unavailable" });
    }
  }

  try {
    switch (event.type) {
      case "session.created": {
        const s = event.data;
        await supabaseAdmin.from("user_sessions").upsert(
          { clerk_user_id: s.user_id, clerk_session_id: s.id, is_active: true, last_seen_at: new Date().toISOString() },
          { onConflict: "clerk_session_id" }
        );
        break;
      }
      case "session.ended":
      case "session.removed":
      case "session.revoked": {
        const s = event.data;
        await supabaseAdmin.from("user_sessions").update({ is_active: false, revoked_at: new Date().toISOString() }).eq("clerk_session_id", s.id);
        break;
      }
      case "user.created": {
        await logSecurityEvent({ clerkUserId: event.data.id, eventType: "user.created", severity: "info" });
        break;
      }
      default:
        break; // ignore events we don't act on
    }
    await supabaseAdmin.from("webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", svixId);
  } catch (err) {
    console.error("[webhooks] failed to process Clerk event:", err);
    // Return non-2xx so Clerk retries the event. The idempotency claim above
    // is intentionally left in place; a retry can detect the claim only after
    // a successful processing marker is written, so stale claims are recoverable.
    await supabaseAdmin.from("webhook_events").delete().eq("id", svixId);
    return res.status(503).json({ error: "Webhook processing failed" });
  }

  res.json({ received: true });
});
