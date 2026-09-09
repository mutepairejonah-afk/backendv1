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
