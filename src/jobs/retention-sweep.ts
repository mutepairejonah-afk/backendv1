/**
 * Expired-message sweep — deletes any message past its `expires_at` timer
 * (Telegram-style disappearing messages set per-message at send time).
 *
 * The client also calls POST /sweep-expired-messages for the conversation
 * it currently has open, so messages disappear immediately while the app is
 * in use. This job is the backstop for conversations nobody has open.
 *
 * Run this on a schedule (e.g. Render Cron Job, every few minutes):
 *   node dist/jobs/retention-sweep.js
 *
 * Or locally: tsx src/jobs/retention-sweep.ts
 */
import "dotenv/config";
import { supabaseAdmin } from "../lib/supabase.js";
import { logSecurityEvent } from "../lib/security.js";

async function run() {
  console.log("[retention-sweep] starting...");

  const { data: deleted, error } = await supabaseAdmin
    .from("messages")
    .delete()
    .not("expires_at", "is", null)
    .lt("expires_at", new Date().toISOString())
    .select("id");

  if (error) {
    console.error("[retention-sweep] failed:", error.message);
    process.exit(1);
  }

  const count = deleted?.length || 0;
  if (count > 0) {
    console.log(`[retention-sweep] deleted ${count} expired messages`);
    await logSecurityEvent({ eventType: "retention.swept", severity: "info", metadata: { deletedCount: count } });
  }

  console.log(`[retention-sweep] done. total messages deleted: ${count}`);
  process.exit(0);
}

run().catch((err) => {
  console.error("[retention-sweep] fatal error:", err);
  process.exit(1);
});
