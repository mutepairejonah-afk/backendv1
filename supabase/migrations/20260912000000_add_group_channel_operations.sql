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
