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
