-- Repair migration for the hosted Reach MVP create flows.
-- Run this in Supabase SQL Editor if the project was deployed without replaying
-- the repository migrations. Every statement is idempotent.

-- Channels are standalone; remove any legacy workspace requirement.
drop policy if exists channels_select on public.channels;
alter table if exists public.channels drop constraint if exists channels_organization_id_name_key;
drop index if exists public.idx_channels_org;
alter table if exists public.channels drop column if exists organization_id;
alter table if exists public.conversations drop column if exists organization_id;

alter table if exists public.channels
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null,
  add column if not exists public_slug text,
  add column if not exists username text,
  add column if not exists description text,
  add column if not exists topic text,
  add column if not exists is_private boolean not null default false,
  add column if not exists is_broadcast boolean not null default false,
  add column if not exists is_discoverable boolean not null default true,
  add column if not exists created_by text,
  add column if not exists archived_at timestamptz,
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists invite_code text,
  add column if not exists invite_expires_at timestamptz,
  add column if not exists slow_mode_seconds integer not null default 0;

-- Status/moment columns used by text and media posts.
alter table if exists public.moments
  add column if not exists video_url text,
  add column if not exists audio_url text,
  add column if not exists thumbnail_url text,
  add column if not exists mime_type text,
  add column if not exists duration_seconds integer,
  add column if not exists expires_at timestamptz;

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  text text,
  image_url text,
  video_url text,
  audio_url text,
  thumbnail_url text,
  mime_type text,
  duration_seconds integer,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  check (text is not null or image_url is not null or video_url is not null or audio_url is not null)
);

alter table if exists public.stories
  add column if not exists clerk_user_id text,
  add column if not exists text text,
  add column if not exists image_url text,
  add column if not exists video_url text,
  add column if not exists audio_url text,
  add column if not exists thumbnail_url text,
  add column if not exists mime_type text,
  add column if not exists duration_seconds integer,
  add column if not exists expires_at timestamptz,
  add column if not exists created_at timestamptz default now();

create table if not exists public.story_views (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  clerk_user_id text not null,
  viewed_at timestamptz not null default now(),
  unique (story_id, clerk_user_id)
);

insert into storage.buckets (id, name, public)
values
  ('moment-images', 'moment-images', true),
  ('moment-media', 'moment-media', true),
  ('chat-media', 'chat-media', true)
on conflict (id) do update set public = excluded.public;

create index if not exists idx_moments_expiry on public.moments(expires_at);
create index if not exists idx_stories_active on public.stories(expires_at, created_at desc);
