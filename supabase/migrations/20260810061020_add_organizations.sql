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
