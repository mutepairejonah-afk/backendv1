#!/usr/bin/env python3
"""
Parses every route file in src/routes/*.ts, extracts each Express route
registration (method, path, requireAuth presence) and the Zod request-body
schema next to it, and emits an OpenAPI 3.0 spec to openapi.json.

This reads the real route files directly -- nothing here is hand-written
per-endpoint, so it stays accurate as routes change (re-run after edits).
"""
import json
import os
import re

ROUTES_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "routes")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "openapi.json")

ROUTE_RE = re.compile(
    r'(\w+Router)\.(get|post|put|delete|patch)\(\s*"([^"]+)"\s*,\s*(.*?)\(req'
)

def find_balanced(s, start):
    """Given s[start] == '{', return the index just after its matching '}'."""
    depth = 0
    i = start
    while i < len(s):
        if s[i] == '{':
            depth += 1
        elif s[i] == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1

def split_top_level(s):
    """Split a string on top-level commas (ignoring commas inside (), {}, [])."""
    parts = []
    depth = 0
    cur = ""
    for ch in s:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts

def classify_zod(expr):
    expr = expr.strip()
    optional = ".optional()" in expr or ".nullable()" in expr or ".default(" in expr
    if expr.startswith("z.string("):
        t = "string"
        if ".uuid()" in expr:
            fmt = "uuid"
        elif ".datetime()" in expr:
            fmt = "date-time"
        elif ".email()" in expr:
            fmt = "email"
        else:
            fmt = None
        return t, fmt, optional
    if expr.startswith("z.number("):
        return "number", None, optional
    if expr.startswith("z.boolean("):
        return "boolean", None, optional
    if expr.startswith("z.array("):
        return "array", None, optional
    if expr.startswith("z.record(") or expr.startswith("z.object("):
        return "object", None, optional
    if expr.startswith("z.enum("):
        return "string", "enum", optional
    if expr.startswith("z.unknown(") or expr.startswith("z.any("):
        return None, None, optional
    return "string", None, optional

def parse_zod_object_fields(body_str):
    """body_str is the content between the outer z.object({ ... }) braces."""
    fields = {}
    required = []
    for part in split_top_level(body_str):
        part = part.strip()
        if not part or ":" not in part:
            continue
        key, _, rest = part.partition(":")
        key = key.strip().strip('"').strip("'")
        if not re.match(r"^[A-Za-z_$][A-Za-z0-9_$]*$", key):
            continue
        t, fmt, optional = classify_zod(rest)
        schema = {}
        if t:
            schema["type"] = t
        if fmt == "enum":
            pass
        elif fmt:
            schema["format"] = fmt
        fields[key] = schema or {"type": "string"}
        if not optional:
            required.append(key)
    return fields, required

def path_to_summary(path):
    words = path.strip("/").replace("-", " ").replace("_", " ")
    return words[:1].upper() + words[1:] if words else path

paths = {}
tags = []

FACTORY_DEF_START_RE = re.compile(r'function\s+route\s*\(')
FACTORY_CALL_RE = re.compile(r'^route\(\s*"([^"]+)"\s*,', re.MULTILINE)
BODY_HELPER_RE = re.compile(r'\bbody\(\s*\{')

def kebab(name):
    # createGroup -> create-group
    s = re.sub(r'(?<!^)(?=[A-Z])', '-', name)
    return s.lower()

for fname in sorted(os.listdir(ROUTES_DIR)):
    if not fname.endswith(".ts") or fname == "index.ts":
        continue
    tag = fname[:-3]
    tags.append(tag)
    with open(os.path.join(ROUTES_DIR, fname)) as f:
        src = f.read()

    # -- Pass 1: direct Router.method("/path", ...) registrations --
    for m in ROUTE_RE.finditer(src):
        router_var, method, route_path, middleware_chain = m.groups()
        requires_auth = "requireAuth" in middleware_chain

        window_end = min(len(src), m.end() + 6000)
        window = src[m.end():window_end]
        zobj = re.search(r"z\.object\(\s*\{", window)
        request_body = None
        if zobj:
            brace_start = m.end() + zobj.end() - 1
            brace_end = find_balanced(src, brace_start)
            if brace_end != -1:
                inner = src[brace_start + 1:brace_end - 1]
                fields, required = parse_zod_object_fields(inner)
                if fields:
                    request_body = {
                        "required": True,
                        "content": {"application/json": {"schema": {
                            "type": "object", "properties": fields,
                            **({"required": required} if required else {}),
                        }}},
                    }

        prefix = "/webhooks" if fname == "webhooks.ts" else "/api"
        openapi_path = prefix + route_path
        operation = {
            "tags": [tag],
            "summary": path_to_summary(route_path),
            "responses": {
                "200": {"description": "Success"},
                "400": {"description": "Validation error"},
                "401": {"description": "Not authenticated"} if requires_auth else None,
                "500": {"description": "Server error"},
            },
        }
        operation["responses"] = {k: v for k, v in operation["responses"].items() if v}
        if requires_auth:
            operation["security"] = [{"clerkAuth": []}]
        if request_body:
            operation["requestBody"] = request_body
        paths.setdefault(openapi_path, {})[method] = operation

    # -- Pass 2: route("name", handler) factory pattern (operations.ts) --
    fstart = FACTORY_DEF_START_RE.search(src)
    if not fstart:
        continue
    def_window = src[fstart.end():fstart.end() + 400]
    method_m = re.search(r'\w+Router\.(get|post|put|delete|patch)\(', def_window)
    if not method_m:
        continue
    factory_method = method_m.group(1)
    factory_requires_auth = "requireAuth" in def_window[:def_window.find(")")+200]

    for cm_ in FACTORY_CALL_RE.finditer(src):
        name = cm_.group(1)
        route_path = "/" + name
        window_end = min(len(src), cm_.end() + 4000)
        window = src[cm_.end():window_end]
        bm = BODY_HELPER_RE.search(window)
        zm = re.search(r"z\.object\(\s*\{", window)
        # Prefer whichever helper appears first (body(...) wraps clerkUserId implicitly).
        use_body_helper = bm and (not zm or bm.start() < zm.start())
        request_body = None
        implicit_clerk_id = False
        brace_start = None
        if use_body_helper and bm:
            brace_start = cm_.end() + bm.end() - 1
            implicit_clerk_id = True
        elif zm:
            brace_start = cm_.end() + zm.end() - 1
        if brace_start is not None:
            brace_end = find_balanced(src, brace_start)
            if brace_end != -1:
                inner = src[brace_start + 1:brace_end - 1]
                fields, required = parse_zod_object_fields(inner)
                if implicit_clerk_id:
                    fields.setdefault("clerkUserId", {"type": "string"})
                    if "clerkUserId" not in required:
                        required.insert(0, "clerkUserId")
                if fields:
                    request_body = {
                        "required": True,
                        "content": {"application/json": {"schema": {
                            "type": "object", "properties": fields,
                            **({"required": required} if required else {}),
                        }}},
                    }

        prefix = "/webhooks" if fname == "webhooks.ts" else "/api"
        openapi_path = prefix + route_path
        operation = {
            "tags": [tag],
            "summary": path_to_summary(kebab(name)),
            "responses": {
                "200": {"description": "Success"},
                "400": {"description": "Validation error"},
                "401": {"description": "Not authenticated"} if factory_requires_auth else None,
                "500": {"description": "Server error"},
            },
        }
        operation["responses"] = {k: v for k, v in operation["responses"].items() if v}
        if factory_requires_auth:
            operation["security"] = [{"clerkAuth": []}]
        if request_body:
            operation["requestBody"] = request_body
        paths.setdefault(openapi_path, {})[factory_method] = operation

spec = {
    "openapi": "3.0.3",
    "info": {
        "title": "Reach Backend API",
        "version": "1.0.0",
        "description": "Auto-generated from src/routes/*.ts (Express + Zod). "
                        "Re-run scripts/gen-openapi.py after changing routes.",
    },
    "servers": [{"url": "https://chatapp-backend.onrender.com", "description": "Production (Render service: chatapp-backend -- edit if your actual URL differs)"}],
    "tags": [{"name": t} for t in tags],
    "components": {
        "securitySchemes": {
            "clerkAuth": {
                "type": "http",
                "scheme": "bearer",
                "description": "Clerk session token (requireAuth middleware)",
            }
        }
    },
    "paths": dict(sorted(paths.items())),
}

with open(OUT_PATH, "w") as f:
    json.dump(spec, f, indent=2)

total_ops = sum(len(v) for v in paths.values())
print(f"Wrote {OUT_PATH}: {len(paths)} paths, {total_ops} operations, {len(tags)} tags")
