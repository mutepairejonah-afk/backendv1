-- Reach messaging-only reset for development/testing.
-- Deletes conversations, messages, reactions, receipts, and related chat state.
-- Preserves profiles, contacts, organizations, channels, billing, and auth.users.
-- Run only in the intended Supabase project.

BEGIN;

TRUNCATE TABLE
  public.message_deletions,
  public.message_reactions,
  public.message_read_receipts,
  public.starred_messages,
  public.scheduled_messages,
  public.poll_votes,
  public.poll_options,
  public.polls,
  public.messages,
  public.conversation_wallpapers,
  public.conversation_members,
  public.conversations
RESTART IDENTITY CASCADE;

COMMIT;
