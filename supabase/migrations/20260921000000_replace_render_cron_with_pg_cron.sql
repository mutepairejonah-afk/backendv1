-- Replaces the Render "chatapp-backend-retention-sweep" cron service (see
-- render.yaml, now removed) with a job scheduled directly inside Postgres.
-- Render has no free tier for cron-type services at all -- this was the one
-- item on the Render side actually generating a bill, for a job whose entire
-- logic is a single DELETE statement. pg_cron runs inside Supabase's existing
-- Postgres instance at no extra cost, so there's nothing left to pay for.
--
-- This does the same thing src/jobs/retention-sweep.ts did: deletes any
-- message past its per-message `expires_at` timer (Telegram-style
-- disappearing messages). The Node script/Render cron are no longer needed
-- for this and have been removed; src/jobs/retention-sweep.ts is kept in the
-- repo only as an optional manual/local fallback (see its updated comment).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

CREATE OR REPLACE FUNCTION public.sweep_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_count integer;
BEGIN
  DELETE FROM public.messages
  WHERE expires_at IS NOT NULL AND expires_at < now();

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  IF v_deleted_count > 0 THEN
    INSERT INTO public.security_events (event_type, severity, metadata)
    VALUES ('retention.swept', 'info', jsonb_build_object('deletedCount', v_deleted_count));
  END IF;
END;
$$;

-- Unschedule first so re-running this migration doesn't create a duplicate
-- job (cron.schedule with a name that already exists errors, it doesn't
-- upsert).
SELECT cron.unschedule('sweep-expired-messages')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-expired-messages');

-- Same daily 03:00 UTC schedule the Render cron used.
SELECT cron.schedule('sweep-expired-messages', '0 3 * * *', 'SELECT public.sweep_expired_messages();');
