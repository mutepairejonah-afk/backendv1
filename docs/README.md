# API Docs (Swagger UI)

Auto-generated OpenAPI spec + Swagger UI page for this backend, built from
the real route files -- nothing here is hand-written per-endpoint.

## Regenerating the spec

After changing any route in `src/routes/*.ts`, run:

```
python3 scripts/gen-openapi.py
cp openapi.json docs/openapi.json
```

This parses every `router.get/post/put/delete/patch("/path", ...)` call
(including the `route("name", handler)` factory pattern used in
`operations.ts`) and extracts the Zod request-body schema next to it, so
required/optional fields and types stay accurate as the routes change.

## Viewing the docs locally

Just open `docs/index.html` in a browser (it loads `./openapi.json` next
to it, no server needed).

## Publishing with GitHub Pages (free)

1. Push this repo (docs/ folder included) to GitHub.
2. Repo Settings -> Pages -> Source: "Deploy from a branch" -> Branch:
   `main`, folder: `/docs`. Save.
3. Your docs will be live at:
   `https://mutepairejonah-afk.github.io/backendv1/`

## Letting "Try it out" actually call your live backend

Swagger UI's "Try it out" sends real requests from the browser to the
`servers[0].url` in `openapi.json` (currently
`https://chatapp-backend.onrender.com` -- edit `scripts/gen-openapi.py`'s
`servers` block if your real Render URL differs, then regenerate).

Your backend's CORS is controlled by the `ALLOWED_ORIGINS` env var
(see `src/index.ts`). Add your GitHub Pages origin to it on Render, e.g.:

```
ALLOWED_ORIGINS=https://reach-frontend-4zcq.onrender.com,https://mutepairejonah-afk.github.io
```

(comma-separated, no trailing slash on the origin), then redeploy the
backend for the change to take effect. Without this, "Try it out" will
fail with a CORS error even though the endpoint itself works fine.

Most endpoints also require a Clerk bearer token (the padlock icon in
Swagger UI) -- click "Authorize" and paste a valid session token to use
"Try it out" on authenticated routes.
