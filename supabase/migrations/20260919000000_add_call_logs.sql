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
