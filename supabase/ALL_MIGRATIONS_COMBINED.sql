-- =============================================================
-- Combined Supabase migrations for reach backend (backendv1)
-- Regenerated 2026-09-19 -- concatenation of every file in
-- supabase/migrations/, in chronological order.
--
-- HOW TO RUN: paste this whole file into the Supabase SQL Editor
-- and run it once. Most statements are idempotent (if not exists /
-- if exists / on conflict), so it is safe even if some of these
-- migrations were already partially applied.
--
-- FIXED in this version: removed a leftover policy in
-- 20260917000000_repair_channel_roles_and_rls_policies.sql that
-- referenced scim_provisioning_log / organization_members --
-- tables an earlier migration (20260905, remove-workspace) already
-- intentionally dropped. That caused: column "organization_id"
-- does not exist (42703).
--
-- IF A STATEMENT ERRORS (e.g. 'already exists'): that piece was
-- already applied previously. Note which file/line failed, remove
-- or comment out just that statement, and re-run the rest.
-- =============================================================

-- =============================================================
-- FILE: 20260810061020_add_organizations.sql
-- =============================================================
-- ═══════════════════════════════════════════════════════════════════════════
-- Organizations / Workspaces layer
-- Run this in the Supabase SQL editor, or via `supabase db push` if you use
-- the CLI. Safe to run once; re-running will error on the CREATE TABLE lines
-- (expected) unless you drop the tables first.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Organizations ────────────────────────────────────────────────────────────
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  logo_url text,
  owner_clerk_id text not null,
  plan text not null default 'free',                -- 'free' | 'pro' | 'enterprise'
  business_type text,                                -- null | 'commerce' (Phase 2)
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_organizations_owner on organizations(owner_clerk_id);

-- ── Membership ────────────────────────────────────────────────────────────────
create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  clerk_user_id text not null,
  role text not null default 'member',               -- 'owner' | 'admin' | 'member' | 'guest'
  department text,
  title text,
  status text not null default 'active',              -- 'active' | 'invited' | 'suspended'
  joined_at timestamptz not null default now(),
  unique (organization_id, clerk_user_id)
);

create index if not exists idx_org_members_org on organization_members(organization_id);
create index if not exists idx_org_members_user on organization_members(clerk_user_id);

-- ── Invites ───────────────────────────────────────────────────────────────────
create table if not exists organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  invited_by text not null,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_org_invites_org on organization_invites(organization_id);
create index if not exists idx_org_invites_email on organization_invites(email);

-- ── Channels ──────────────────────────────────────────────────────────────────
create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  name text not null,
  topic text,
  is_private boolean not null default false,
  created_by text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

create index if not exists idx_channels_org on channels(organization_id);
create index if not exists idx_channels_conversation on channels(conversation_id);

create table if not exists channel_members (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  clerk_user_id text not null,
  role text not null default 'member',                -- 'admin' | 'member'
  muted boolean not null default false,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  unique (channel_id, clerk_user_id)
);

create index if not exists idx_channel_members_channel on channel_members(channel_id);
create index if not exists idx_channel_members_user on channel_members(clerk_user_id);

-- ── Retention & compliance ───────────────────────────────────────────────────
create table if not exists retention_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  scope text not null default 'org',                  -- 'org' | 'channel'
  channel_id uuid references channels(id) on delete cascade,
  retention_days int,                                  -- null = keep forever
  legal_hold boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_retention_org on retention_policies(organization_id);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_clerk_id text not null,
  action text not null,                                -- e.g. 'member.invited', 'channel.archived'
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_org on audit_logs(organization_id, created_at desc);

-- ── SCIM provisioning log (for Phase 1.4 directory sync) ─────────────────────
create table if not exists scim_provisioning_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  external_id text not null,
  action text not null,                                -- 'create' | 'update' | 'deactivate'
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ── Extend conversations for channel support ─────────────────────────────────
-- Your `conversations.type` is currently 'direct' | 'group'. Add 'channel'.
-- If `type` is a text column with a CHECK constraint, update it like this:
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'conversations' and column_name = 'type'
  ) then
    begin
      alter table conversations drop constraint if exists conversations_type_check;
      alter table conversations add constraint conversations_type_check
        check (type in ('direct', 'group', 'channel'));
    exception when others then
      raise notice 'Could not update conversations.type constraint automatically — check it manually.';
    end;
  end if;
end $$;

alter table conversations add column if not exists organization_id uuid references organizations(id) on delete cascade;
create index if not exists idx_conversations_org on conversations(organization_id);

-- ── updated_at trigger for organizations ─────────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_organizations_updated_at on organizations;
create trigger trg_organizations_updated_at
  before update on organizations
  for each row execute function set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
-- Note: your backend uses the Supabase SERVICE ROLE key (supabaseAdmin), which
-- bypasses RLS entirely — authorization for API requests is enforced in your
-- Express route code (see organizations.ts / channels.ts), not by these
-- policies. These RLS policies exist as defense-in-depth in case the frontend
-- ever queries Supabase directly with a user-scoped key.
-- ═══════════════════════════════════════════════════════════════════════════

alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table organization_invites enable row level security;
alter table channels enable row level security;
alter table channel_members enable row level security;
alter table retention_policies enable row level security;
alter table audit_logs enable row level security;

-- Members can see orgs they belong to
drop policy if exists org_select_member on organizations;
create policy org_select_member on organizations for select
  using (
    exists (
      select 1 from organization_members m
      where m.organization_id = organizations.id
        and m.clerk_user_id = auth.jwt()->>'sub'
    )
  );

-- Members can see other members of their own orgs
drop policy if exists org_members_select on organization_members;
create policy org_members_select on organization_members for select
  using (
    exists (
      select 1 from organization_members m2
      where m2.organization_id = organization_members.organization_id
        and m2.clerk_user_id = auth.jwt()->>'sub'
    )
  );

-- Members can see channels in their org, unless private and they're not in it
drop policy if exists channels_select on channels;
create policy channels_select on channels for select
  using (
    exists (
      select 1 from organization_members m
      where m.organization_id = channels.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
    )
    and (
      not channels.is_private
      or exists (
        select 1 from channel_members cm
        where cm.channel_id = channels.id
          and cm.clerk_user_id = auth.jwt()->>'sub'
      )
    )
  );

drop policy if exists channel_members_select on channel_members;
create policy channel_members_select on channel_members for select
  using (
    exists (
      select 1 from channel_members cm2
      where cm2.channel_id = channel_members.channel_id
        and cm2.clerk_user_id = auth.jwt()->>'sub'
    )
  );

-- Audit logs: only admins/owners of the org can read
drop policy if exists audit_logs_select on audit_logs;
create policy audit_logs_select on audit_logs for select
  using (
    exists (
      select 1 from organization_members m
      where m.organization_id = audit_logs.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

-- retention_policies: same as audit_logs — admins/owners only
drop policy if exists retention_select on retention_policies;
create policy retention_select on retention_policies for select
  using (
    exists (
      select 1 from organization_members m
      where m.organization_id = retention_policies.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

-- organization_invites: only admins/owners can read
drop policy if exists invites_select on organization_invites;
create policy invites_select on organization_invites for select
  using (
    exists (
      select 1 from organization_members m
      where m.organization_id = organization_invites.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

-- No insert/update/delete policies are defined here on purpose: all writes
-- go through your Express backend using the service role key, which bypasses
-- RLS. If you later add direct client writes, add matching write policies.

-- =============================================================
-- FILE: 20260810061500_add_security_layer.sql
-- =============================================================
-- ═══════════════════════════════════════════════════════════════════════════
-- Security hardening layer
-- Run this AFTER 20260810061020_add_organizations.sql (it references
-- organizations.id and organization_members).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Per-org security policy ───────────────────────────────────────────────────
create table if not exists security_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references organizations(id) on delete cascade,
  require_mfa boolean not null default false,          -- enforce Clerk MFA for members
  allowed_ip_ranges text[] not null default '{}',       -- CIDR list; empty = no restriction
  session_timeout_minutes int not null default 10080,   -- 7 days
  allow_guest_access boolean not null default true,
  max_failed_logins int not null default 10,            -- informational; enforcement is in Clerk
  updated_at timestamptz not null default now()
);

-- ── Device / session tracking ─────────────────────────────────────────────────
-- Populated from Clerk webhooks (session.created / session.ended / session.removed)
-- and from a lightweight "device fingerprint" your frontend can send on login.
create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  clerk_session_id text unique,
  organization_id uuid references organizations(id) on delete cascade,
  ip_address text,
  user_agent text,
  device_label text,                                     -- e.g. "Chrome on Windows"
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_user_sessions_user on user_sessions(clerk_user_id);
create index if not exists idx_user_sessions_org on user_sessions(organization_id);
create index if not exists idx_user_sessions_active on user_sessions(clerk_user_id, is_active);

-- ── Security event log (distinct from general audit_logs — this is specifically
--    for anomaly review: failed auths, blocked IPs, permission-escalation attempts,
--    rate-limit trips, new-device logins) ────────────────────────────────────────
create table if not exists security_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  clerk_user_id text,
  event_type text not null,        -- 'login.new_device' | 'login.blocked_ip' | 'auth.invalid_token'
                                    -- | 'ratelimit.exceeded' | 'permission.denied' | 'export.triggered'
  severity text not null default 'info',  -- 'info' | 'warning' | 'critical'
  ip_address text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_security_events_org on security_events(organization_id, created_at desc);
create index if not exists idx_security_events_severity on security_events(severity, created_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────────
alter table security_settings enable row level security;
alter table user_sessions enable row level security;
alter table security_events enable row level security;

drop policy if exists security_settings_select on security_settings;
create policy security_settings_select on security_settings for select
  using (
    exists (
      select 1 from organization_members m
      where m.organization_id = security_settings.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

drop policy if exists user_sessions_select_own on user_sessions;
create policy user_sessions_select_own on user_sessions for select
  using (clerk_user_id = auth.jwt()->>'sub');

drop policy if exists security_events_select on security_events;
create policy security_events_select on security_events for select
  using (
    exists (
      select 1 from organization_members m
      where m.organization_id = security_events.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

-- As before: all writes go through the backend's service-role key, which
-- bypasses RLS. These policies are for any direct client reads only.

-- =============================================================
-- FILE: 20260810070000_add_commerce_layer.sql
-- =============================================================
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 — Economic layer: in-chat commerce + org payroll payouts
-- Run AFTER 20260810061020_add_organizations.sql and
-- 20260810061500_add_security_layer.sql.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Catalog ───────────────────────────────────────────────────────────────────
create table if not exists catalog_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'USD',
  image_url text,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_catalog_items_org on catalog_items(organization_id, active);

-- ── Orders ────────────────────────────────────────────────────────────────────
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_clerk_id text not null,
  conversation_id uuid references conversations(id) on delete set null,
  status text not null default 'pending',   -- 'pending' | 'paid' | 'fulfilled' | 'cancelled'
  total_cents integer not null default 0,
  currency text not null default 'USD',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_org on orders(organization_id, status);
create index if not exists idx_orders_customer on orders(customer_clerk_id);
create index if not exists idx_orders_conversation on orders(conversation_id);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  catalog_item_id uuid references catalog_items(id) on delete set null,
  name_snapshot text not null,        -- captured at order time, survives catalog edits
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0)
);

create index if not exists idx_order_items_order on order_items(order_id);

-- ── Invoices / payment verification (reuses the EcoCash manual-verify pattern
--    already used for premium subscriptions in `payments`) ────────────────────
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  amount_cents integer not null,
  currency text not null default 'USD',
  ecocash_reference text,
  screenshot_url text,
  status text not null default 'pending',   -- 'pending' | 'verified' | 'rejected'
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_invoices_order on invoices(order_id);
create index if not exists idx_invoices_status on invoices(status);

-- ── Org payroll payouts (internal economic layer — admins pay members) ──────
create table if not exists payroll_payouts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  recipient_clerk_id text not null,
  initiated_by text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD',
  reason text,                                -- 'salary' | 'reimbursement' | 'bonus' | free text
  ecocash_reference text,
  status text not null default 'pending',     -- 'pending' | 'paid' | 'failed'
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists idx_payroll_org on payroll_payouts(organization_id, status);
create index if not exists idx_payroll_recipient on payroll_payouts(recipient_clerk_id);

-- ── Link messages to orders (mirrors the existing messages.poll_id pattern) ──
alter table messages add column if not exists order_id uuid references orders(id) on delete set null;
create index if not exists idx_messages_order on messages(order_id);

-- ── updated_at triggers (reuses set_updated_at() from the org migration) ────
drop trigger if exists trg_catalog_items_updated_at on catalog_items;
create trigger trg_catalog_items_updated_at
  before update on catalog_items
  for each row execute function set_updated_at();

drop trigger if exists trg_orders_updated_at on orders;
create trigger trg_orders_updated_at
  before update on orders
  for each row execute function set_updated_at();

-- ── Storage bucket for catalog product images ────────────────────────────────
insert into storage.buckets (id, name, public)
values ('catalog-images', 'catalog-images', true)
on conflict (id) do nothing;

-- ── RLS ────────────────────────────────────────────────────────────────────────
alter table catalog_items enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table invoices enable row level security;
alter table payroll_payouts enable row level security;

drop policy if exists catalog_items_select on catalog_items;
create policy catalog_items_select on catalog_items for select
  using (active = true or exists (
    select 1 from organization_members m
    where m.organization_id = catalog_items.organization_id
      and m.clerk_user_id = auth.jwt()->>'sub'
  ));

drop policy if exists orders_select_own on orders;
create policy orders_select_own on orders for select
  using (
    customer_clerk_id = auth.jwt()->>'sub'
    or exists (
      select 1 from organization_members m
      where m.organization_id = orders.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

drop policy if exists payroll_select_own on payroll_payouts;
create policy payroll_select_own on payroll_payouts for select
  using (
    recipient_clerk_id = auth.jwt()->>'sub'
    or exists (
      select 1 from organization_members m
      where m.organization_id = payroll_payouts.organization_id
        and m.clerk_user_id = auth.jwt()->>'sub'
        and m.role in ('owner', 'admin')
    )
  );

-- As with prior migrations: writes go through the backend's service-role
-- key and bypass RLS; these policies protect any direct client reads.

-- =============================================================
-- FILE: 20260815000000_add_telegram_style_channels.sql
-- =============================================================
-- ═══════════════════════════════════════════════════════════════════════════
-- Telegram-style channels: shareable invite links, broadcast (admin-post-only)
-- channels, and instant join. Run AFTER 20260810061020_add_organizations.sql.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Invite link (like t.me/joinchat/XXXX) ────────────────────────────────────
alter table channels add column if not exists invite_code text unique default encode(gen_random_bytes(9), 'base64');
-- base64 can contain '/' and '+' which are awkward in URLs — normalize existing/defaults:
update channels set invite_code = replace(replace(invite_code, '/', '_'), '+', '-') where invite_code is not null;

-- ── Broadcast mode: true = only admins can post, members can only read
--    (this is what makes a channel behave like a Telegram "channel" rather
--    than a "group" — everyone else already gets normal groups) ────────────
alter table channels add column if not exists is_broadcast boolean not null default false;

-- ── Public directory flag: separate from is_private. A channel can be
--    "public" (findable + joinable without a link, listed in org discovery)
--    or only joinable via invite_code even if not marked private (Telegram's
--    "public channel with a link but not listed" pattern). ─────────────────
alter table channels add column if not exists is_discoverable boolean not null default true;

-- ── Subscriber count cache (avoids a COUNT(*) query on every channel list
--    render — Telegram channels can have huge member counts) ───────────────
alter table channels add column if not exists member_count integer not null default 0;

create or replace function sync_channel_member_count()
returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    update channels set member_count = member_count + 1 where id = new.channel_id;
  elsif TG_OP = 'DELETE' then
    update channels set member_count = greatest(0, member_count - 1) where id = old.channel_id;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_channel_member_count on channel_members;
create trigger trg_channel_member_count
  after insert or delete on channel_members
  for each row execute function sync_channel_member_count();

-- Backfill existing counts
update channels c set member_count = (select count(*) from channel_members cm where cm.channel_id = c.id);

create index if not exists idx_channels_invite_code on channels(invite_code);
create index if not exists idx_channels_discoverable on channels(organization_id, is_discoverable) where is_private = false;

-- =============================================================
-- FILE: 20260827000000_add_saved_items.sql
-- =============================================================
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

-- =============================================================
-- FILE: 20260901000000_add_channel_followers.sql
-- =============================================================
-- Telegram-style public channel subscriptions.
-- Subscribers are separate from channel admins/members but can still read the
-- backing conversation through a matching conversation_members row.

alter table public.channels add column if not exists public_slug text;

update public.channels
set public_slug = regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g') || '-' || substr(replace(id::text, '-', ''), 1, 8)
where public_slug is null;

create unique index if not exists channels_public_slug_uidx
  on public.channels(public_slug) where public_slug is not null;

create index if not exists channels_public_discovery_idx
  on public.channels(is_discoverable, is_private, archived_at, created_at desc);

comment on column public.channels.public_slug is 'Stable public discovery slug; the UUID suffix prevents collisions.';
comment on column public.channel_members.role is 'admin = owner/moderator, member = org/channel member, subscriber = Telegram-style follower';

create index if not exists channel_subscribers_channel_idx
  on public.channel_members(channel_id, joined_at desc)
  where role = 'subscriber';

create index if not exists channel_subscribers_user_idx
  on public.channel_members(clerk_user_id, joined_at desc)
  where role = 'subscriber';

-- =============================================================
-- FILE: 20260901010000_add_webhook_events.sql
-- =============================================================
-- Idempotency ledger for provider webhooks. The Svix event ID is globally unique
-- and lets retries safely re-enter the endpoint without replaying side effects.
create table if not exists public.webhook_events (
  id text primary key,
  provider text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists webhook_events_provider_received_idx
  on public.webhook_events(provider, received_at desc);

alter table public.webhook_events enable row level security;

-- =============================================================
-- FILE: 20260903000000_add_chat_and_message_deletion.sql
-- =============================================================
-- WhatsApp-style deletion:
--   1. "Delete for everyone" on a message already existed (messages.is_deleted
--      tombstone) — this migration does not touch that.
--   2. "Delete for me" on a single message: hides it from one user's view
--      only, without affecting the conversation for anyone else.
--   3. "Clear chat": wipes a conversation's message history from one user's
--      view (like WhatsApp's "Clear chat") without deleting the conversation
--      itself or affecting other members.
--   4. "Delete chat": removes a conversation from one user's chat list (like
--      WhatsApp's "Delete chat"). If a new message arrives afterward, the
--      chat reappears in their list — same behavior as WhatsApp — because
--      this is judged by comparing conversations.updated_at against
--      conversation_members.deleted_at at query time, not by actually
--      removing the membership row.

-- ── Per-user message deletion ("delete for me") ─────────────────────────────
CREATE TABLE IF NOT EXISTS message_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_deletions_user
  ON message_deletions (clerk_user_id);

CREATE INDEX IF NOT EXISTS idx_message_deletions_message
  ON message_deletions (message_id);

-- ── Per-user chat clearing / deletion ────────────────────────────────────────
-- cleared_at: hides all messages created before this timestamp, for this
--             member only. New messages after this point still show.
-- deleted_at: hides the whole conversation from this member's chat list.
--             Automatically "undeletes" the next time the conversation gets
--             a newer message than this timestamp (matches WhatsApp).
ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- =============================================================
-- FILE: 20260905000000_remove_workspace_make_telegram.sql
-- =============================================================
-- ═══════════════════════════════════════════════════════════════════════════
-- Remove the Slack-style "workspace" (organizations) layer, the in-chat
-- commerce layer, org payroll, and WhatsApp-style Stories — and convert
-- channels + security settings from org-scoped to a flat, Telegram-style
-- shape (any user can create a channel; security/privacy settings are
-- per-user). Run this AFTER all prior migrations in this folder.
--
-- This is a destructive migration: any data in the dropped tables/columns
-- is gone once it runs. Back up first if this project has real users.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Detach channels & conversations from organizations ───────────────────────
alter table if exists channels drop constraint if exists channels_organization_id_name_key;
drop index if exists idx_channels_org;
drop index if exists channels_public_discovery_idx;
alter table if exists channels drop column if exists organization_id;
create index if not exists channels_public_discovery_idx
  on public.channels(is_discoverable, is_private, archived_at, created_at desc);

drop index if exists idx_conversations_org;
alter table if exists conversations drop column if exists organization_id;

-- ── Convert security settings from per-organization to per-user ─────────────
-- (Fresh feature, safe to recreate rather than migrate row-by-row.)
drop table if exists security_settings cascade;
create table security_settings (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  two_step_enabled boolean not null default false,
  login_alerts_enabled boolean not null default true,
  session_timeout_minutes int not null default 10080,   -- 7 days
  updated_at timestamptz not null default now()
);

alter table if exists user_sessions drop column if exists organization_id;
alter table if exists security_events drop column if exists organization_id;

alter table security_settings enable row level security;
drop policy if exists security_settings_select_own on security_settings;
create policy security_settings_select_own on security_settings for select
  using (clerk_user_id = auth.jwt()->>'sub');

-- ── Drop the organizations / workspace layer entirely ────────────────────────
drop table if exists scim_provisioning_log cascade;
drop table if exists audit_logs cascade;
drop table if exists retention_policies cascade;
drop table if exists organization_invites cascade;
drop table if exists organization_members cascade;
drop table if exists organizations cascade;

-- ── Drop the in-chat commerce layer ───────────────────────────────────────────
alter table if exists messages drop column if exists order_id;
drop table if exists invoices cascade;
drop table if exists order_items cascade;
drop table if exists orders cascade;
drop table if exists catalog_items cascade;

-- ── Drop org payroll ──────────────────────────────────────────────────────────
drop table if exists payroll_payouts cascade;

-- ── Drop WhatsApp-style Stories (Moments is kept as the status feature) ──────
drop table if exists story_views cascade;
drop table if exists story_highlights cascade;
drop table if exists stories cascade;

-- ── Drop leftover manual EcoCash payment/subscription-approval tables ───────
-- (superseded: subscription tier is now set directly by your billing
-- provider's webhook via POST /upgrade-plan — see src/routes/premium.ts)
drop table if exists payments cascade;
drop table if exists ecocash_settings cascade;

-- =============================================================
-- FILE: 20260908000000_add_media_status_stories_channel_controls.sql
-- =============================================================
-- Reach media/status and Telegram-style channel controls.
-- Additive migration: preserves existing data and tables.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_type text,
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS width integer,
  ADD COLUMN IF NOT EXISTS height integer;

ALTER TABLE public.moments
  ADD COLUMN IF NOT EXISTS video_url text,
  ADD COLUMN IF NOT EXISTS audio_url text,
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_moments_user_created
  ON public.moments(clerk_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moments_expiry
  ON public.moments(expires_at);

CREATE TABLE IF NOT EXISTS public.stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  text text,
  image_url text,
  video_url text,
  audio_url text,
  thumbnail_url text,
  mime_type text,
  duration_seconds integer,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (text IS NOT NULL OR image_url IS NOT NULL OR video_url IS NOT NULL OR audio_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_stories_active
  ON public.stories(expires_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_user
  ON public.stories(clerk_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.story_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (story_id, clerk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_story_views_story ON public.story_views(story_id);

ALTER TABLE public.channels
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS slow_mode_seconds integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_channels_invite_active
  ON public.channels(invite_code, invite_expires_at);

INSERT INTO storage.buckets (id, name, public)
VALUES ('moment-media', 'moment-media', true)
ON CONFLICT (id) DO NOTHING;

-- =============================================================
-- FILE: 20260909000000_add_telegram_channel_features.sql
-- =============================================================
-- Reach Telegram-style channel controls and metadata.
ALTER TABLE public.channels
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS comments_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signatures_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_reactions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{"membersCanReact": true, "membersCanPin": false, "membersCanInvite": false}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS channels_username_uidx
  ON public.channels(lower(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS channels_username_search_idx
  ON public.channels(lower(username));

COMMENT ON COLUMN public.channels.username IS 'Telegram-style public @username, unique case-insensitively.';
COMMENT ON COLUMN public.channels.permissions IS 'Channel feature permissions controlled by admins.';

CREATE TABLE IF NOT EXISTS public.channel_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, clerk_user_id)
);
CREATE INDEX IF NOT EXISTS channel_join_requests_pending_idx
  ON public.channel_join_requests(channel_id, created_at DESC) WHERE status = 'pending';

-- =============================================================
-- FILE: 20260910000000_repair_create_flows.sql
-- =============================================================
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

-- =============================================================
-- FILE: 20260912000000_add_group_channel_operations.sql
-- =============================================================
-- Complete operation API support for groups, channels, moderation, invites, and scheduling.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS slow_mode_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_delete_seconds integer;

ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS restrictions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS muted_until timestamptz,
  ADD COLUMN IF NOT EXISTS admin_title text,
  ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.channel_members
  ADD COLUMN IF NOT EXISTS admin_title text,
  ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_by text,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS silent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anonymous_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.invite_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('group','channel')),
  target_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  revoked_at timestamptz,
  expires_at timestamptz,
  max_uses integer,
  uses integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invite_links_target_idx ON public.invite_links(target_type, target_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('group','channel')),
  target_id uuid NOT NULL,
  actor_clerk_user_id text NOT NULL,
  action text NOT NULL,
  target_clerk_user_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON public.admin_audit_log(target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.message_viewers (
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS messages_scheduled_idx ON public.messages(scheduled_at) WHERE scheduled_at IS NOT NULL AND published_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_pinned_idx ON public.messages(conversation_id, pinned) WHERE pinned = true;

CREATE OR REPLACE FUNCTION public.increment_message_view_count(p_message_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.messages SET view_count = view_count + 1 WHERE id = p_message_id RETURNING view_count INTO v_count;
  RETURN COALESCE(v_count, 0);
END; $$;

CREATE TABLE IF NOT EXISTS public.group_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, clerk_user_id)
);
CREATE INDEX IF NOT EXISTS group_join_requests_pending_idx ON public.group_join_requests(conversation_id, created_at DESC) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.channel_comments_links (
  channel_id uuid PRIMARY KEY REFERENCES public.channels(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_type_idx ON public.conversations(type, created_at DESC);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON public.conversation_members(clerk_user_id, conversation_id);
CREATE INDEX IF NOT EXISTS channel_members_user_idx ON public.channel_members(clerk_user_id, channel_id);

-- =============================================================
-- FILE: 20260913000000_repair_moments_and_highlights.sql
-- =============================================================
-- Repair for deployments that predate the moments/media and story tables.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.moments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  text text,
  image_url text,
  video_url text,
  audio_url text,
  thumbnail_url text,
  mime_type text,
  duration_seconds integer,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moments_has_content CHECK (text IS NOT NULL OR image_url IS NOT NULL OR video_url IS NOT NULL OR audio_url IS NOT NULL)
);
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS clerk_user_id text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS text text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS video_url text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS audio_url text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS mime_type text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS duration_seconds integer;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS expires_at timestamptz DEFAULT (now() + interval '24 hours');
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.moment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id uuid NOT NULL REFERENCES public.moments(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(moment_id, clerk_user_id)
);
CREATE TABLE IF NOT EXISTS public.moment_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id uuid NOT NULL REFERENCES public.moments(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  text text,
  image_url text,
  video_url text,
  audio_url text,
  thumbnail_url text,
  mime_type text,
  duration_seconds integer,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.story_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(story_id, clerk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_moments_created ON public.moments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_owner_created ON public.stories(clerk_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.story_highlights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  title text NOT NULL DEFAULT 'Highlight',
  cover_url text,
  story_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_story_highlights_owner ON public.story_highlights(clerk_user_id, created_at ASC);

-- =============================================================
-- FILE: 20260913010000_add_payments_and_ecocash.sql
-- =============================================================
-- Payment review and EcoCash settings used by the admin dashboard.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  user_display_name text,
  amount numeric(10,2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'ZiG')),
  transaction_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  screenshot_url text,
  approved_by text,
  processed_at timestamptz,
  rejection_reason text,
  dispute_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON public.payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_status_idx ON public.payments(status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ecocash_settings (
  id integer PRIMARY KEY DEFAULT 1,
  usd_to_zig_rate numeric(10,4) NOT NULL DEFAULT 13.5000,
  ecocash_number text NOT NULL DEFAULT '0788800342',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ecocash_settings (id, usd_to_zig_rate, ecocash_number)
VALUES (1, 13.5, '0788800342')
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-receipts', 'payment-receipts', true)
ON CONFLICT (id) DO UPDATE SET public = excluded.public;

-- =============================================================
-- FILE: 20260914000000_add_smart_spaces_and_user_theme.sql
-- =============================================================
create table if not exists public.smart_spaces (
  id uuid primary key default gen_random_uuid(),
  owner_clerk_user_id text not null,
  title text not null check (char_length(title) between 1 and 80),
  icon text not null default '◆',
  color text not null default '#2f9cf4',
  include_unread_only boolean not null default false,
  include_direct boolean not null default true,
  include_groups boolean not null default true,
  include_channels boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists smart_spaces_owner_idx on public.smart_spaces(owner_clerk_user_id);
create index if not exists smart_spaces_owner_order_idx on public.smart_spaces(owner_clerk_user_id, sort_order);

create table if not exists public.smart_space_rules (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.smart_spaces(id) on delete cascade,
  chat_id text not null,
  entity_type text not null default 'conversation' check (entity_type in ('conversation', 'channel')),
  rule_type text not null check (rule_type in ('whitelist', 'blacklist')),
  created_at timestamptz not null default now(),
  unique(space_id, chat_id, entity_type, rule_type)
);
create index if not exists smart_space_rules_space_idx on public.smart_space_rules(space_id);
create index if not exists smart_space_rules_chat_idx on public.smart_space_rules(space_id, chat_id);

create table if not exists public.user_preferences (
  clerk_user_id text primary key,
  theme text not null default 'chatgram' check (theme in ('dark', 'light', 'chatgram')),
  updated_at timestamptz not null default now()
);

alter table public.smart_spaces enable row level security;
alter table public.smart_space_rules enable row level security;
alter table public.user_preferences enable row level security;

-- The backend uses the Supabase service role after Clerk verification; no public policies are needed.
comment on table public.smart_spaces is 'User-owned rule-based views over conversations and channels';
comment on table public.smart_space_rules is 'Explicit whitelist/blacklist overrides for Smart Spaces';
comment on table public.user_preferences is 'Authenticated user UI preferences, including theme';

-- =============================================================
-- FILE: 20260917000000_repair_channel_roles_and_rls_policies.sql
-- =============================================================
-- Synchronize channel creator roles and close Supabase RLS advisor findings.

UPDATE public.conversation_members cm
SET role = 'admin'
FROM public.channels ch
WHERE ch.conversation_id = cm.conversation_id
  AND ch.created_by = cm.clerk_user_id
  AND cm.role <> 'admin';

ALTER TABLE public.ping ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_audit_log_member_select ON public.admin_audit_log;
CREATE POLICY admin_audit_log_member_select ON public.admin_audit_log FOR SELECT USING (actor_clerk_user_id = (auth.jwt() ->> 'sub') OR target_clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS channel_comments_links_member_select ON public.channel_comments_links;
CREATE POLICY channel_comments_links_member_select ON public.channel_comments_links FOR SELECT USING (EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel_id = channel_comments_links.channel_id AND cm.clerk_user_id = (auth.jwt() ->> 'sub')));

DROP POLICY IF EXISTS channel_join_requests_owner_select ON public.channel_join_requests;
CREATE POLICY channel_join_requests_owner_select ON public.channel_join_requests FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub') OR EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel_id = channel_join_requests.channel_id AND cm.clerk_user_id = (auth.jwt() ->> 'sub') AND cm.role = 'admin'));

DROP POLICY IF EXISTS channels_discoverable_select ON public.channels;
CREATE POLICY channels_discoverable_select ON public.channels FOR SELECT USING ((NOT is_private AND is_discoverable AND archived_at IS NULL) OR created_by = (auth.jwt() ->> 'sub') OR EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel_id = channels.id AND cm.clerk_user_id = (auth.jwt() ->> 'sub')));

DROP POLICY IF EXISTS group_join_requests_member_select ON public.group_join_requests;
CREATE POLICY group_join_requests_member_select ON public.group_join_requests FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub') OR EXISTS (SELECT 1 FROM public.conversation_members cm WHERE cm.conversation_id = group_join_requests.conversation_id AND cm.clerk_user_id = (auth.jwt() ->> 'sub') AND cm.role = 'admin'));

DROP POLICY IF EXISTS invite_links_creator_select ON public.invite_links;
CREATE POLICY invite_links_creator_select ON public.invite_links FOR SELECT USING (created_by = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS message_deletions_owner_select ON public.message_deletions;
CREATE POLICY message_deletions_owner_select ON public.message_deletions FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS message_viewers_owner_select ON public.message_viewers;
CREATE POLICY message_viewers_owner_select ON public.message_viewers FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS order_items_authenticated_select ON public.order_items;
CREATE POLICY order_items_authenticated_select ON public.order_items FOR SELECT USING (auth.role() = 'authenticated');

-- Note: scim_provisioning_log / organization_members no longer exist -- the
-- organization/workspace layer was intentionally dropped by
-- 20260905000000_remove_workspace_make_telegram.sql. A leftover policy for
-- scim_provisioning_log_admin_select was removed from here for that reason.

DROP POLICY IF EXISTS smart_space_rules_owner_select ON public.smart_space_rules;
CREATE POLICY smart_space_rules_owner_select ON public.smart_space_rules FOR SELECT USING (EXISTS (SELECT 1 FROM public.smart_spaces ss WHERE ss.id = smart_space_rules.space_id AND ss.owner_clerk_user_id = (auth.jwt() ->> 'sub')));

DROP POLICY IF EXISTS smart_spaces_owner_select ON public.smart_spaces;
CREATE POLICY smart_spaces_owner_select ON public.smart_spaces FOR SELECT USING (owner_clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS telegram_chat_links_owner_select ON public.telegram_chat_links;
CREATE POLICY telegram_chat_links_owner_select ON public.telegram_chat_links FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS telegram_links_owner_select ON public.telegram_links;
CREATE POLICY telegram_links_owner_select ON public.telegram_links FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS user_preferences_owner_select ON public.user_preferences;
CREATE POLICY user_preferences_owner_select ON public.user_preferences FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS webhook_events_admin_select ON public.webhook_events;
CREATE POLICY webhook_events_admin_select ON public.webhook_events FOR SELECT USING (false);

DROP POLICY IF EXISTS ping_no_public_access ON public.ping;
CREATE POLICY ping_no_public_access ON public.ping FOR SELECT USING (false);

DROP POLICY IF EXISTS invoices_no_public_access ON public.invoices;
CREATE POLICY invoices_no_public_access ON public.invoices FOR SELECT USING (false);

REVOKE EXECUTE ON FUNCTION public.increment_message_view_count(uuid) FROM authenticated, anon;

-- =============================================================
-- FILE: 20260919000000_add_call_logs.sql
-- =============================================================
-- call_logs is used by src/routes/calls.ts (/log-call, /get-call-history,
-- /delete-call-log, /clear-call-history) but was never created by a
-- migration, so those endpoints fail with "relation does not exist".
-- Live calling itself (WebRTC signaling via socket.ts) does not depend on
-- this table -- only call history/logging does.

create table if not exists public.call_logs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller_clerk_id text not null,
  callee_clerk_id text not null,
  kind text not null check (kind in ('audio', 'video')),
  status text not null check (status in ('answered', 'missed', 'rejected', 'cancelled')),
  duration_seconds integer not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists call_logs_caller_idx on public.call_logs(caller_clerk_id, started_at desc);
create index if not exists call_logs_callee_idx on public.call_logs(callee_clerk_id, started_at desc);
create index if not exists call_logs_conversation_idx on public.call_logs(conversation_id);

alter table public.call_logs enable row level security;

