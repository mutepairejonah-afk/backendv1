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
