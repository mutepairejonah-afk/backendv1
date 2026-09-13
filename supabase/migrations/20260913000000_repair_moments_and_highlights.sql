-- Repair for deployments that predate the moments/media and story tables.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.moments (
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
  CONSTRAINT moments_has_content CHECK (text IS NOT NULL OR image_url IS NOT NULL OR video_url IS NOT NULL OR audio_url IS NOT NULL)
);
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS clerk_user_id text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS text text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS video_url text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS audio_url text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS mime_type text;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS duration_seconds integer;
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS expires_at timestamptz DEFAULT (now() + interval '24 hours');
ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.moment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id uuid NOT NULL REFERENCES public.moments(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(moment_id, clerk_user_id)
);
CREATE TABLE IF NOT EXISTS public.moment_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id uuid NOT NULL REFERENCES public.moments(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
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
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.story_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES public.stories(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(story_id, clerk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_moments_created ON public.moments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_owner_created ON public.stories(clerk_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.story_highlights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL,
  title text NOT NULL DEFAULT 'Highlight',
  cover_url text,
  story_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_story_highlights_owner ON public.story_highlights(clerk_user_id, created_at ASC);
