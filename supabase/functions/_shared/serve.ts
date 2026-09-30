import { handleCors, json } from "./cors.ts";
import { requireAuth } from "./auth.ts";
import { ZodError } from "npm:zod@^3";

export type Handler = (body: Record<string, unknown>, clerkUserId: string, req: Request) => Promise<unknown>;

/**
 * Mirrors the `rp()` wrapper used throughout the Node route files: parses
 * JSON, runs the handler, and maps thrown errors to sensible HTTP statuses
 * consistently. `routes` is keyed by the exact original Express path (e.g.
 * "/ai/conversation-brief", "/ai-chat-assist") so the frontend's path suffix
 * after the function's own base URL stays identical to before the move --
 * only the host/function-name prefix changes.
 */
export function serve(routes: Record<string, Handler>) {
  Deno.serve(async (req: Request) => {
    const cors = handleCors(req);
    if (cors) return cors;

    const url = new URL(req.url);
    // Strip the function's own name segment: for a request to
    // .../functions/v1/ai/ai/conversation-brief, functionsIndex points at
    // "ai" (the function name) and everything after it is the original path.
    const segments = url.pathname.split("/").filter(Boolean);
    const functionsIndex = segments.indexOf("functions");
    const routePath = functionsIndex >= 0
      ? "/" + segments.slice(functionsIndex + 3).join("/") // skip "functions", "v1", "<fn-name>"
      : url.pathname;

    const handler = routes[routePath];
    if (!handler) {
      return json({ error: `Not found: ${routePath}` }, 404);
    }

    try {
      // Two ways to authenticate a request:
      // 1. A real Clerk Bearer token from an end user (the normal path).
      // 2. X-Internal-Secret + an explicit clerkUserId in the body, for
      //    trusted server-to-server calls from the Render backend, which
      //    already verified the user itself (e.g. src/socket.ts's ai:chat
      //    event, called on a long-lived socket connection where the
      //    original short-lived Clerk token from the handshake would have
      //    expired long before a later event fires). This is the same trust
      //    model as src/routes/internal.ts on the Render side, just in the
      //    other direction.
      const internalSecret = req.headers.get("x-internal-secret");
      const configuredSecret = Deno.env.get("INTERNAL_FUNCTIONS_SECRET");
      let clerkUserId: string;
      let body: Record<string, unknown> = {};
      if (req.method !== "GET") {
        const text = await req.text();
        if (text) body = JSON.parse(text);
      }

      if (configuredSecret && internalSecret === configuredSecret && typeof body.clerkUserId === "string" && body.clerkUserId) {
        clerkUserId = body.clerkUserId;
      } else {
        clerkUserId = await requireAuth(req);
      }

      // Same rule as the Node middleware: the verified/trusted identity wins
      // over whatever else might be in the body, so a caller can never act as
      // someone else by spoofing this field. Preserve what was actually sent
      // under callerSuppliedClerkUserId for the few handlers that use
      // `clerkUserId` to mean "the other user", same as the Node side.
      if (typeof body.clerkUserId === "string") {
        body.callerSuppliedClerkUserId = body.clerkUserId;
      }
      body.clerkUserId = clerkUserId;
      const result = await handler(body, clerkUserId, req);
      return json(result);
    } catch (err) {
      if (err instanceof ZodError) return json({ error: err.issues[0]?.message || "Invalid request" }, 400);
      const status = (err && typeof err === "object" && "status" in err && typeof (err as any).status === "number") ? (err as any).status : 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error(`[${routePath}]`, err);
      return json({ error: message }, status);
    }
  });
}
