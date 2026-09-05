-- WhatsApp-style deletion:
--   1. "Delete for everyone" on a message already existed (messages.is_deleted
--      tombstone) — this migration does not touch that.
--   2. "Delete for me" on a single message: hides it from one user's view
--      only, without affecting the conversation for anyone else.
--   3. "Clear chat": wipes a conversation's message history from one user's
--      view (like WhatsApp's "Clear chat") without deleting the conversation
--      itself or affecting other members.
--   4. "Delete chat": removes a conversation from one user's chat list (like
--      WhatsApp's "Delete chat"). If a new message arrives afterward, the
--      chat reappears in their list — same behavior as WhatsApp — because
--      this is judged by comparing conversations.updated_at against
--      conversation_members.deleted_at at query time, not by actually
--      removing the membership row.

-- ── Per-user message deletion ("delete for me") ─────────────────────────────
CREATE TABLE IF NOT EXISTS message_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_deletions_user
  ON message_deletions (clerk_user_id);

CREATE INDEX IF NOT EXISTS idx_message_deletions_message
  ON message_deletions (message_id);

-- ── Per-user chat clearing / deletion ────────────────────────────────────────
-- cleared_at: hides all messages created before this timestamp, for this
--             member only. New messages after this point still show.
-- deleted_at: hides the whole conversation from this member's chat list.
--             Automatically "undeletes" the next time the conversation gets
--             a newer message than this timestamp (matches WhatsApp).
ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
