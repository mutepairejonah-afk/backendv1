/**
 * Expired-message sweep — deletes any message past its `expires_at` timer
 * (Telegram-style disappearing messages set per-message at send time).
 *
 * This is no longer scheduled anywhere by default. The actual sweep runs as
 * a pg_cron job directly inside Supabase Postgres instead -- see
 * supabase/migrations/20260921000000_replace_render_cron_with_pg_cron.sql --
 * since that runs for free inside the existing database, whereas a Render
 * cron service is billed separately with no free tier. This script is kept
 * only as an optional manual/local fallback (e.g. to run a one-off sweep
 * from your machine): `npm run retention-sweep`.
 *
 * The client also calls POST /sweep-expired-messages for the conversation
 * it currently has open, so messages disappear immediately while the app is
 * in use; the pg_cron job is the backstop for conversations nobody has open.
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
