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
