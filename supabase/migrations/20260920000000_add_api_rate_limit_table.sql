-- The Node backend's rate limiter (src/lib/rate-limit.ts) uses an in-memory
-- Map, which works fine on a single long-lived Render process. Supabase Edge
-- Functions are short-lived, independently-scaled Deno isolates -- an
-- in-memory Map there would not be shared across invocations, making rate
-- limiting silently ineffective. This table + RPC gives the moved AI/media/
-- payments Edge Functions an atomic, shared rate limiter instead.

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL
);

-- Best-effort cleanup of old buckets; not required for correctness (expired
-- rows are also handled correctly, just not deleted, by check_rate_limit
-- itself), but keeps the table from growing unbounded.
CREATE INDEX IF NOT EXISTS api_rate_limits_reset_at_idx ON public.api_rate_limits(reset_at);

-- Atomically checks and increments a rate-limit bucket. Returns true if the
-- request is allowed, false if the caller is over the limit. Safe under
-- concurrent calls for the same key (single UPDATE/INSERT statement with a
-- row-level lock via ON CONFLICT, no read-then-write race).
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_reqs integer, p_window_ms integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_new_reset timestamptz := v_now + (p_window_ms || ' milliseconds')::interval;
  v_count integer;
BEGIN
  INSERT INTO public.api_rate_limits (key, count, reset_at)
  VALUES (p_key, 1, v_new_reset)
  ON CONFLICT (key) DO UPDATE SET
    count = CASE
      WHEN public.api_rate_limits.reset_at <= v_now THEN 1
      ELSE public.api_rate_limits.count + 1
    END,
    reset_at = CASE
      WHEN public.api_rate_limits.reset_at <= v_now THEN v_new_reset
      ELSE public.api_rate_limits.reset_at
    END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max_reqs;
END;
$$;

-- Occasionally sweep expired buckets. Call this from a scheduled job if you
-- have one; harmless to skip, the table just grows slightly over time.
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limits()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.api_rate_limits WHERE reset_at < now() - interval '1 hour';
$$;

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies granted: only the service-role key (used by Edge Functions,
-- which bypasses RLS) and the SECURITY DEFINER functions above can touch
-- this table. It holds no user-readable data, so there's no "authenticated
-- select own rows" policy to add.
