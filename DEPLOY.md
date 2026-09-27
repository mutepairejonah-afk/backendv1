# Deploying the ChatApp backend

The backend is a standalone Node.js service. It owns REST API routes, Socket.IO, authentication, and server-side AI calls. Deploy it as a long-running web service with the start command `npm start` and a public HTTP port supplied through `PORT`.

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
OPENROUTER_API_KEY=...
```

Set either `OPENROUTER_API_KEY` or `GEMINI_API_KEY`. The backend never sends these keys to the frontend. If using Gemini, set `GEMINI_MODEL` to a currently available model. For WebRTC calls, configure a public TURN server with `TURN_SECRET`, `TURN_PUBLIC_HOST`, and `TURN_PORT`; localhost TURN settings are not suitable for production phones.

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
flyctl launch --no-deploy   # first time only, or edit the `app` name in fly.toml to one you've already reserved
flyctl secrets set CLERK_SECRET_KEY=... CLERK_WEBHOOK_SECRET=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENROUTER_API_KEY=... ALLOWED_ORIGINS=https://your-frontend.example.com
flyctl deploy
```

Set every secret listed in [Required environment variables](#required-environment-variables) this way (anything marked `sync: false` in `render.yaml`) — `flyctl secrets set` persists them across deploys, so this is a one-time step per app, not per deploy.

`min_machines_running = 1` with `auto_stop_machines = "off"` keeps exactly one machine warm at all times, rather than Fly's usual scale-to-zero. This is intentional: the backend holds long-lived Socket.IO connections for realtime messages, calls, and presence, and scale-to-zero would silently drop those connections whenever traffic dipped.

**The `retention-sweep` cron job stays on Render** (see `render.yaml`) even if you move the main web service to Fly. Fly doesn't have a built-in scheduled-job service type the way Render does — running it there would mean a Fly Machine on a systemd-timer/cron trigger, which is more setup than the job is worth. Render's `cron` service type already runs it natively for about $1/month; there's no reason to migrate a job this small and this cheap. If you do want it fully off Render at some point, the equivalent on Fly is `flyctl machine run` with a scheduled trigger, or an external scheduler (e.g. GitHub Actions on a `schedule:` cron) hitting a one-off script — neither is set up here.

## Pre-deployment checks

```bash
npm ci
npm run build
npm audit --omit=dev --audit-level=high
curl https://api.example.com/health
```

## Supabase schema migrations

Neither Render nor Fly automatically executes Supabase SQL migrations. Before using channel creation, Moments, or Stories on an existing Supabase project, run the files in `supabase/migrations/` in timestamp order in the Supabase SQL Editor, or paste `supabase/ALL_MIGRATIONS_COMBINED.sql` in one shot for a fresh project. The repair migration `20260910000000_repair_create_flows.sql` is idempotent and restores the standalone channel columns, status/story tables, media columns, and public storage buckets used by the create endpoints.
