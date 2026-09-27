-- Several tables are used by src/routes/operations.ts, channels.ts, and
-- messages.ts, and have RLS policies written for them in
-- 20260917000000_repair_channel_roles_and_rls_policies.sql, but were never
-- defined by a CREATE TABLE anywhere in this migration history — they exist
-- only because they were created by hand on the live project at some point.
-- A fresh database (or anyone replaying ALL_MIGRATIONS_COMBINED.sql from
-- scratch) would fail with "relation does not exist" errors. This migration
-- defines them, matching the columns each route already reads/writes.
-- Every statement is idempotent and safe to run against a database that
-- already has these tables from manual setup.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Used by: operations.ts audit()/getAdminAuditLog — records moderator actions
-- taken on a group or channel (role changes, removals, etc.).
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('group', 'channel')),
  target_id uuid NOT NULL,
  actor_clerk_user_id text NOT NULL,
  action text NOT NULL,
  target_clerk_user_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx ON public.admin_audit_log(target_type, target_id, created_at DESC);

-- Used by: operations.ts linkCommentsGroup/unlinkCommentsGroup/getCommentsGroup
-- and channels.ts — the "discussion group" a broadcast channel's posts are
-- linked to for threaded comments (Telegram's linked-discussion-group feature).
CREATE TABLE IF NOT EXISTS public.channel_comments_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL UNIQUE REFERENCES public.channels(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Used by: channels.ts request-to-join-channel / respond-to-join-request flow.
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
CREATE INDEX IF NOT EXISTS channel_join_requests_channel_idx ON public.channel_join_requests(channel_id, status, created_at DESC);

-- Used by: operations.ts createJoinRequest/reviewGroupJoin — same idea as
-- channel_join_requests, for a private group's "request to join" flow.
CREATE TABLE IF NOT EXISTS public.group_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, clerk_user_id)
);
CREATE INDEX IF NOT EXISTS group_join_requests_conversation_idx ON public.group_join_requests(conversation_id, status, created_at DESC);

-- Used by: operations.ts createInviteLink/revokeInviteLink/getInviteLinkInfo —
-- shareable invite links (with optional expiry / use-limit) for a group or
-- channel, distinct from a channel's own single invite_code column.
CREATE TABLE IF NOT EXISTS public.invite_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('group', 'channel')),
  target_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  expires_at timestamptz,
  max_uses integer,
  uses_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invite_links_creator_idx ON public.invite_links(created_by, created_at DESC);

-- Used by: messages.ts "delete for me" — hides a message for one participant
-- without deleting it for everyone else in the conversation.
CREATE TABLE IF NOT EXISTS public.message_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, clerk_user_id)
);
CREATE INDEX IF NOT EXISTS message_deletions_user_idx ON public.message_deletions(clerk_user_id, message_id);

-- Referenced by the RLS policy in 20260917000000 but not yet wired to a
-- route — reserved for per-message "seen by" viewer tracking (a channel post
-- view-count breakdown), matching the same shape as story_views.
CREATE TABLE IF NOT EXISTS public.message_viewers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, clerk_user_id)
);

-- Referenced by the RLS policy in 20260917000000 but not yet wired to a
-- route — reserved for a future real-Telegram account-linking / bridge
-- feature (per-chat and per-user link records).
CREATE TABLE IF NOT EXISTS public.telegram_chat_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  telegram_chat_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.telegram_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL UNIQUE,
  telegram_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_comments_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_chat_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_links ENABLE ROW LEVEL SECURITY;
