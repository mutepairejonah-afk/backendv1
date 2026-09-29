// Edge Functions have no Socket.IO connections of their own -- only the
// Render process does. When a moved endpoint needs to trigger a realtime
// broadcast after writing to the database, it calls this internal bridge
// endpoint on Render instead. See src/routes/internal.ts on the Node side.
// If RENDER_INTERNAL_URL / INTERNAL_FUNCTIONS_SECRET aren't configured, this
// silently no-ops rather than failing the whole request -- a missed realtime
// nudge is much less bad than a failed upload.
export async function notifyRenderBroadcast(path: string, body: Record<string, unknown>): Promise<void> {
  const baseUrl = Deno.env.get("RENDER_INTERNAL_URL");
  const secret = Deno.env.get("INTERNAL_FUNCTIONS_SECRET");
  if (!baseUrl || !secret) {
    console.warn(`[broadcast] RENDER_INTERNAL_URL/INTERNAL_FUNCTIONS_SECRET not set, skipping broadcast to ${path}`);
    return;
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[broadcast] ${path} returned ${res.status}`);
  } catch (err) {
    console.warn(`[broadcast] failed to reach Render for ${path}:`, err);
  }
}
