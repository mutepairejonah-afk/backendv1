import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { join } from "path";
// Load backend/.env first (if present), then fall back to the root .env so the
// backend can inherit all shared credentials without duplicating them.
dotenv.config(); // backend/.env (may not exist — that's fine)
dotenv.config({ path: join(process.cwd(), "../.env"), override: false });
import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { attachSocketServer } from "./socket.js";
import { apiRouter } from "./routes/index.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { globalRateLimit } from "./lib/security.js";

const app = express();
app.set("trust proxy", 1);

app.use((req, res, next) => {
  const requestId = req.header("x-request-id") || randomUUID();
  res.setHeader("x-request-id", requestId);
  const started = Date.now();
  res.on("finish", () => {
    if (req.path !== "/health") console.log(JSON.stringify({ type: "http_request", requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started, ip: req.ip }));
  });
  next();
});

// ── Security headers ────────────────────────────────────────────────────────
// Sets sane defaults (X-Frame-Options, X-Content-Type-Options, HSTS, etc).
// CSP is left to the frontend's own hosting config since this is an API server,
// not a page-serving one — a strict default CSP here would just get ignored
// by browsers on JSON responses anyway.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));

// ── Webhooks (must come before express.json() — svix needs the raw body) ────
app.use("/webhooks", webhooksRouter);

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true;
  // Capacitor uses capacitor://localhost on iOS, and https://localhost on
  // Android when androidScheme is set to "https" (the default/recommended
  // setting). Both must be allowed in production, or every Android build
  // gets rejected by CORS.
  if (origin === "capacitor://localhost" || origin === "ionic://localhost" || origin === "https://localhost") return true;
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(?::\d+)?$/.test(origin)) return true;
  if (process.env.NODE_ENV !== "production" && /^http:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)[0-9.]+(?::\d+)?$/.test(origin)) return true;
  if (process.env.NODE_ENV !== "production" && /^https:\/\/([a-z0-9-]+\.)*replit\.dev$/.test(origin)) return true;
  if (process.env.NODE_ENV !== "production" && /^https:\/\/([a-z0-9-]+\.)*repl\.co$/.test(origin)) return true;
  return false;
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, same-origin)
      if (!origin) return callback(null, true);
      if (isAllowedOrigin(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);

// Keep ordinary API requests small. Base64 media uploads are explicitly
// allowlisted below and still have route-level Zod/file-size validation.
const largeBodyRoutes = [
  "/api/upload-chat-media",
  "/api/upload-document-message",
  "/api/upload-avatar",
  "/api/upload-moment-image",
  "/api/upload-group-avatar",
];
for (const route of largeBodyRoutes) app.use(route, express.json({ limit: "20mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ── Global rate limit (applies to every /api request, keyed by IP) ──────────
app.use("/api", globalRateLimit);

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/ready", (_req, res) => res.json({ ok: true, ready: true }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api", apiRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: err?.message || "Internal server error" });
});

// ── HTTP + Socket.io ──────────────────────────────────────────────────────────
const requiredEnv = ["CLERK_SECRET_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]?.trim());
if (missingEnv.length) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);
}
if (!process.env.GEMINI_API_KEY?.trim() && !process.env.OPENROUTER_API_KEY?.trim()) {
  throw new Error("Configure GEMINI_API_KEY or OPENROUTER_API_KEY for AI features");
}

const httpServer = createServer(app);
const ioServer = attachSocketServer(httpServer);

// Socket.IO is served by the same HTTP server as the API. Keeping one listener
// avoids sharing a Socket.IO instance across two HTTP servers, which can cause
// duplicate upgrade handling and unreliable connections in Capacitor WebViews.

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "0.0.0.0";
httpServer.listen(PORT, HOST, () => {
  console.log(`[server] ChatApp backend running at http://${HOST}:${PORT}`);
});

const shutdown = (signal: string) => {
  console.log(`[server] received ${signal}; shutting down gracefully`);
  ioServer.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
