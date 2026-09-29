// Mirrors src/middleware/auth.ts's requireAuth, adapted for a Fetch-API-style
// handler instead of Express middleware. @clerk/backend is pure JS (uses jose
// under the hood for JWT/JWKS verification over plain fetch), so it works
// unmodified in Deno via the npm: specifier -- no hand-rolled JWT code needed.
import { verifyToken } from "npm:@clerk/backend@^1";

export class AuthError extends Error {
  status = 401;
}

/**
 * Verifies the request's Clerk Bearer token and returns the authenticated
 * user's id. Throws AuthError (401) if missing/invalid -- callers should let
 * this propagate to the shared error handler.
 */
export async function requireAuth(req: Request): Promise<string> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("Unauthorized: missing Bearer token");
  }
  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, {
      secretKey: Deno.env.get("CLERK_SECRET_KEY"),
    });
    return payload.sub;
  } catch {
    throw new AuthError("Unauthorized: invalid token");
  }
}
