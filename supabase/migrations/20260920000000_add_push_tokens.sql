-- Replaces the in-memory `pushTokens` Map in src/socket.ts, which had two
-- real problems: (1) unbounded growth for the life of the process -- one
-- entry per distinct user, never removed; (2) total data loss on every
-- restart, and Render's free tier spins the service down on inactivity,
-- so push notifications would silently stop working for every user until
-- each one reopened the app and reconnected. A DB-backed table also lets
-- one user register tokens from multiple devices, which the old
-- Map<clerkUserId, token> couldn't (the second device's token just
-- overwrote the first).

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (token)
);

create index if not exists push_tokens_clerk_user_idx on public.push_tokens(clerk_user_id);

alter table public.push_tokens enable row level security;
