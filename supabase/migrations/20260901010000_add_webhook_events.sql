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
