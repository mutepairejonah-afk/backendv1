# Deploying the ChatApp backend

The backend is split across two places now:

- **This Node.js service** (Render/Fly) owns REST API routes for chat/social features, Socket.IO, and authentication. Deploy it as a long-running web service with the start command `npm start` and a public HTTP port supplied through `PORT`.
- **Supabase Edge Functions** (`supabase/functions/`) own the AI endpoints, file uploads, and EcoCash payments — moved there to keep this Node service's compute footprint light enough to stay comfortably on a free tier. See `supabase/functions/README.md` for that half of the deploy.

## Required environment variables

Set these in the hosting provider's secret manager, not in Git:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=<provider supplied port, or 3001>
ALLOWED_ORIGINS=https://your-frontend.example.com
CLERK_SECRET_KEY=...
CLERK_WEBHOOK_SECRET=...
ADMIN_CLERK_ID=user_...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
INTERNAL_FUNCTIONS_SECRET=...
SUPABASE_FUNCTIONS_URL=...
```

This Node service no longer needs its own AI provider key at all -- `src/socket.ts`'s realtime `ai:chat` event calls the `ai` Supabase Edge Function's `/ai-chat-assist` (via `SUPABASE_FUNCTIONS_URL` + `INTERNAL_FUNCTIONS_SECRET`) rather than running the AI call in-process, so `GEMINI_API_KEY`/`OPENROUTER_API_KEY` now only need to be set as Edge Function secrets (see `supabase/functions/README.md`), not here. `INTERNAL_FUNCTIONS_SECRET` is used in both directions: it authenticates calls from the `media` Edge Function back to this service (triggering a realtime broadcast after a video upload), and calls from this service to the `ai` Edge Function (the `ai:chat` event above) -- generate one long random value and set the identical value on both sides. For WebRTC calls, configure a public TURN server with `TURN_SECRET`, `TURN_PUBLIC_HOST`, and `TURN_PORT`; localhost TURN settings are not suitable for production phones.

`ADMIN_CLERK_ID` is the Clerk **user ID** of the backend administrator, not the email address and not the Clerk session ID. You can set `ADMIN_CLERK_IDS` instead when multiple backend administrators are needed, using comma-separated Clerk user IDs. Add this variable in Render under **Service → Environment → Environment Variables**, then redeploy. The configured administrator can manage groups and channels without first being listed as a member.

## Generic deployment

```bash
npm ci
npm run build
npm start
```

Health check URL:

```text
GET /health
```

Readiness URL:

```text
GET /ready
```

Every response includes an `x-request-id` header. Include that value when reporting an error; the server emits structured JSON access logs containing the request ID, path, status, duration, and client IP. Render sends `SIGTERM` during replacement deploys, and the backend closes Socket.IO and HTTP connections gracefully before exiting.

Socket.IO endpoint:

```text
/socket.io
```

Use HTTPS at the hosting provider. The frontend's production `VITE_API_URL` must be the public backend URL, for example `https://api.example.com`, and the backend `ALLOWED_ORIGINS` must contain the exact frontend origin.

## Docker

```bash
docker build -t chatapp-backend .
docker run --env-file .env -p 3001:3001 chatapp-backend
```

The image has a non-root runtime user and a Docker health check. Docker Compose also includes coturn for self-hosted WebRTC TURN, but coturn requires a public IP/domain and firewall configuration; it is optional for ordinary chat and AI deployment.

## Fly.io

`fly.toml` in the repo root deploys the main web service to Fly using the existing `Dockerfile` — no separate Fly-specific Dockerfile needed.

```bash
flyctl secrets set CLERK_SECRET_KEY=... CLERK_WEBHOOK_SECRET=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... INTERNAL_FUNCTIONS_SECRET=... SUPABASE_FUNCTIONS_URL=... ALLOWED_ORIGINS=https://your-frontend.example.com
flyctl deploy
```

The Fly app (`backendv1-wp9-qa`, region `ams`) already exists from an earlier `flyctl launch` run, so `flyctl deploy` alone is enough here. On a brand-new Fly account/app, run `flyctl launch --no-deploy` first (or edit the `app` name in `fly.toml` to one you've reserved).

Set every secret listed in [Required environment variables](#required-environment-variables) this way (anything marked `sync: false` in `render.yaml`) — `flyctl secrets set` persists them across deploys, so this is a one-time step per app, not per deploy.

`min_machines_running = 1` with `auto_stop_machines = "off"` keeps exactly one machine warm at all times, rather than Fly's usual scale-to-zero. This is intentional: the backend holds long-lived Socket.IO connections for realtime messages, calls, and presence, and scale-to-zero would silently drop those connections whenever traffic dipped.

**The retention-sweep job doesn't run on Render or Fly at all anymore.** It used to be a separate Render cron service — the only billed line item in `render.yaml`, since Render has no free tier for cron-type services — for a job whose entire logic is one SQL `DELETE` statement. It now runs as a `pg_cron` job directly inside Supabase Postgres (see `supabase/migrations/20260921000000_replace_render_cron_with_pg_cron.sql`), which is free on every Supabase plan and needs no separate service on either host. `src/jobs/retention-sweep.ts` is kept in the repo only as an optional manual/local fallback (`npm run retention-sweep`) — nothing schedules it by default.

## Supabase Edge Functions

The `ai`, `media`, and `payments` functions in `supabase/functions/` must be deployed separately from this Node service — they don't run on Render/Fly at all. Full details, including why the large-video upload endpoints use a two-step signed-URL flow instead of a single request, are in `supabase/functions/README.md`. Short version:

```bash
supabase secrets set CLERK_SECRET_KEY=... GEMINI_API_KEY=... OPENROUTER_API_KEY=... ADMIN_CLERK_ID=... RENDER_INTERNAL_URL=https://your-service.onrender.com INTERNAL_FUNCTIONS_SECRET=<same value set on Render>
supabase functions deploy ai
supabase functions deploy media
supabase functions deploy payments
```

The frontend needs updating to call these at their own Supabase URLs (`https://<project>.supabase.co/functions/v1/<name><original-path>`) instead of this service's `/api/...` paths for anything that used to be `ai.ts`, `agent.ts`, `media.ts`, or `payments.ts`.

## Pre-deployment checks

```bash
npm ci
npm run build
npm audit --omit=dev --audit-level=high
curl https://api.example.com/health
```

## Supabase schema migrations

Neither Render nor Fly automatically executes Supabase SQL migrations. Before using channel creation, Moments, or Stories on an existing Supabase project, run the files in `supabase/migrations/` in timestamp order in the Supabase SQL Editor, or paste `supabase/ALL_MIGRATIONS_COMBINED.sql` in one shot for a fresh project. The repair migration `20260910000000_repair_create_flows.sql` is idempotent and restores the standalone channel columns, status/story tables, media columns, and public storage buckets used by the create endpoints.
