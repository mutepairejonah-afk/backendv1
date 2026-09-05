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
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENROUTER_API_KEY=...
```

Set either `OPENROUTER_API_KEY` or `GEMINI_API_KEY`. The backend never sends these keys to the frontend. If using Gemini, set `GEMINI_MODEL` to a currently available model. For WebRTC calls, configure a public TURN server with `TURN_SECRET`, `TURN_PUBLIC_HOST`, and `TURN_PORT`; localhost TURN settings are not suitable for production phones.

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

## Pre-deployment checks

```bash
npm ci
npm run build
npm audit --omit=dev --audit-level=high
curl https://api.example.com/health
```
