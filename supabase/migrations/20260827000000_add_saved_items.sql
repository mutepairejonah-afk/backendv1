-- ═══════════════════════════════════════════════════════════════════════════
-- Saved Items (bookmarks) — lets a user save any message or arbitrary note
-- privately, with an optional label, for later reference.
--
-- NOTE: the source this was merged from also defined its own `channels` /
-- `channel_members` / `channel_posts` tables for a standalone broadcast-
-- channel feature. Those are deliberately NOT included here — they collide
-- (same table names, different schema) with the org-scoped Telegram-style
-- channels already built in 20260810061020_add_organizations.sql and
-- 20260815000000_add_telegram_style_channels.sql, which already cover the
-- same "channel" concept with more integration (org membership, RBAC,
-- invite links, broadcast mode). Only run this file, don't pull in the
-- channels-related tables from the original source.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

create table if not exists public.saved_items (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  conversation_id uuid null,
  message_id uuid null,
  content text not null,
  title varchar(200) null,
  label varchar(80) null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_items_user_created_idx on public.saved_items (clerk_user_id, created_at desc);
create index if not exists saved_items_user_label_idx on public.saved_items (clerk_user_id, label);
create index if not exists saved_items_content_search_idx on public.saved_items using gin (to_tsvector('simple', content));

-- The backend uses the Supabase service role after Clerk authorization. This
-- policy prevents accidental anon/key-based access if the table is queried
-- directly from a client in the future.
alter table public.saved_items enable row level security;

drop policy if exists saved_items_select_own on public.saved_items;
create policy saved_items_select_own on public.saved_items for select
  using (clerk_user_id = auth.jwt()->>'sub');
