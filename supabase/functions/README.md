# Supabase Edge Functions

Three functions here replace what used to be `src/routes/ai.ts`, `agent.ts`,
`media.ts`, and `payments.ts` in the Node/Render backend. They were moved out
to keep the Render web service light enough to stay comfortably within its
free-tier resource limits — Socket.IO (realtime messages/calls/presence) is
the one thing that has to stay on a long-lived process, so it's the only
thing left there.

| Function | Replaces | Endpoints |
|---|---|---|
| `ai` | `src/routes/ai.ts` + `agent.ts` | 18 endpoints: drafting, translation, summarization, moderation, semantic search, the conversational agent, etc. |
| `media` | `src/routes/media.ts` | Avatar/chat-media/document/moment-image uploads, plus a signed-URL upload flow for large videos (see below) |
| `payments` | `src/routes/payments.ts` | EcoCash payment submission, admin approval, settings |

## Why media's large-video endpoints look different

Edge Functions have a **256MB memory ceiling per request**. The old
`upload-video-status` and `upload-story-media` endpoints accepted up to a
100MB video as base64 inside the JSON body — base64 inflates that to ~133MB
of text, which then gets parsed and decoded into another ~100MB buffer.
That's well past the ceiling and would fail with a `546
WORKER_RESOURCE_LIMIT` error under real usage.

Instead, those two are now a **two-step signed-upload-URL flow**:

1. Client calls `create-video-status-upload-url` (or
   `create-story-media-upload-url`) — a tiny request, returns a short-lived
   signed Storage URL.
2. Client `PUT`s the raw video bytes **directly to Supabase Storage** using
   that URL, with the file's `Content-Type` header set. The file body never
   passes through the Edge Function at all, so there's no size ceiling to
   worry about here — only Supabase Storage's own limits apply.
3. Client calls `finalize-video-status` (or `confirm-story-media-upload`) to
   create the DB row / get back the public URL.

This is a **frontend contract change** for those two upload flows — anything
calling the old single-step `upload-video-status` or `upload-story-media`
needs to be updated to the two-step flow. Every other endpoint (including the
smaller `upload-avatar`, `upload-moment-image`, `upload-chat-media`,
`upload-document-message`, and all of `payments`) is a same-request,
same-contract port — no frontend changes needed there beyond the base URL.

## Why realtime broadcasts still need Render

Edge Functions are stateless and short-lived — they don't hold Socket.IO
connections. Only the Render process does. So `finalize-video-status` calls
an internal endpoint on Render (`POST /internal/broadcast-moment-created`,
see `src/routes/internal.ts`) after writing to the database, authenticated
with a shared secret (`INTERNAL_FUNCTIONS_SECRET`) rather than a user's Clerk
token. If that secret isn't configured on either side, the broadcast is
silently skipped rather than failing the whole upload — a missed realtime
nudge is much less bad than a failed video upload.

## Why rate limiting is DB-backed here, not in-memory

`src/lib/rate-limit.ts` (Node) uses an in-memory `Map`, which works because
Render runs one long-lived process. Edge Function invocations are independent
Deno isolates with no shared memory, so an in-memory limiter here would
silently do nothing under real traffic. `_shared/rate-limit.ts` instead calls
a `check_rate_limit` Postgres RPC (see
`supabase/migrations/20260920000000_add_api_rate_limit_table.sql`) that's
atomic under concurrent calls.

## Deploying

```bash
# One-time secrets setup (persists across deploys):
supabase secrets set \
  CLERK_SECRET_KEY=sk_live_... \
  GEMINI_API_KEY=... \
  OPENROUTER_API_KEY=... \
  ADMIN_CLERK_ID=user_... \
  RENDER_INTERNAL_URL=https://your-service.onrender.com \
  INTERNAL_FUNCTIONS_SECRET=<same value set on Render>

supabase functions deploy ai
supabase functions deploy media
supabase functions deploy payments
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically to
deployed functions by the platform — don't set those with `secrets set`.

Run the migration in `supabase/migrations/20260920000000_add_api_rate_limit_table.sql`
before deploying (it's already included if you replay
`supabase/ALL_MIGRATIONS_COMBINED.sql`).

## Local development

```bash
supabase functions serve --env-file supabase/functions/.env
```

Copy `.env.example` in this directory to `.env` and fill it in first.

## Calling these functions from the frontend

Base URL for each: `https://<project-ref>.supabase.co/functions/v1/<function-name>`

The path after that matches the **original Express route path**, e.g. the
old `POST /api/ai/conversation-brief` on Render becomes:

```
POST https://<project-ref>.supabase.co/functions/v1/ai/ai/conversation-brief
```

(yes, `/ai/ai/...` — the first `ai` is the function name, the second is the
original path segment; this was a deliberate choice to keep every other path
suffix identical to what it was before, so only the base URL needs to change
per feature area). Send the user's Clerk session token the same way as
before: `Authorization: Bearer <token>`.

## Keeping this in sync with the Node backend

There's no shared build step between the Node backend (`src/`) and these
Edge Functions — `_shared/ai.ts` and `_shared/agent.ts` are direct ports of
`src/lib/ai.ts` and `src/lib/agent.ts`, and `_shared/permissions.ts` /
`_shared/admin.ts` mirror their Node equivalents. If you change prompts,
model selection, or permission logic in one place, update the other by hand.
