-- Reach development/staging data reset
-- WARNING: This permanently deletes application data from the public schema.
-- It does not drop tables, remove migrations, or delete auth.users.
-- Run only in the intended Supabase project.
--
-- Recommended use: Supabase SQL Editor with the correct project selected.

BEGIN;

DO $$
DECLARE
  tables_to_clear text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename)
    INTO tables_to_clear
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename = ANY (ARRAY[
      'profiles',
      'contacts',
      'blocked_users',
      'conversations',
      'conversation_members',
      'conversation_wallpapers',
      'messages',
      'message_deletions',
      'message_reactions',
      'message_read_receipts',
      'starred_messages',
      'scheduled_messages',
      'polls',
      'poll_options',
      'poll_votes',
      'organizations',
      'organization_members',
      'organization_invites',
      'channels',
      'channel_members',
      'retention_policies',
      'audit_logs',
      'scim_provisioning_log',
      'webhook_events',
      'user_sessions',
      'security_settings',
      'security_events',
      'call_logs',
      'moments',
      'moment_comments',
      'moment_likes',
      'stories',
      'story_views',
      'story_highlights',
      'saved_items',
      'reports',
      'catalog',
      'catalog_items',
      'orders',
      'order_items',
      'invoices',
      'payments',
      'payment',
      'ecocash_settings',
      'payroll_payouts',
      'chat',
      'moment',
      'story'
    ]);

  IF tables_to_clear IS NULL THEN
    RAISE NOTICE 'No matching Reach tables found in public schema; nothing was cleared.';
  ELSE
    RAISE NOTICE 'Clearing Reach tables: %', tables_to_clear;
    EXECUTE 'TRUNCATE TABLE ' || tables_to_clear || ' RESTART IDENTITY CASCADE';
  END IF;
END $$;

-- Review the NOTICE output before committing in a production-like environment.
-- In development, keep COMMIT. To test without deleting anything, replace it
-- with ROLLBACK before execution.
COMMIT;
