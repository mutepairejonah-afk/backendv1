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
