-- Synchronize channel creator roles and close Supabase RLS advisor findings.

UPDATE public.conversation_members cm
SET role = 'admin'
FROM public.channels ch
WHERE ch.conversation_id = cm.conversation_id
  AND ch.created_by = cm.clerk_user_id
  AND cm.role <> 'admin';

-- ping has no CREATE TABLE anywhere in the tracked migration history (it was
-- created manually on the live project as a trivial DB-connectivity health
-- check). Create it defensively so this script also succeeds on a fresh
-- database instead of failing here.
CREATE TABLE IF NOT EXISTS public.ping (
  id boolean PRIMARY KEY DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ping_singleton CHECK (id)
);

ALTER TABLE public.ping ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_audit_log_member_select ON public.admin_audit_log;
CREATE POLICY admin_audit_log_member_select ON public.admin_audit_log FOR SELECT USING (actor_clerk_user_id = (auth.jwt() ->> 'sub') OR target_clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS channel_comments_links_member_select ON public.channel_comments_links;
CREATE POLICY channel_comments_links_member_select ON public.channel_comments_links FOR SELECT USING (EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel_id = channel_comments_links.channel_id AND cm.clerk_user_id = (auth.jwt() ->> 'sub')));

DROP POLICY IF EXISTS channel_join_requests_owner_select ON public.channel_join_requests;
CREATE POLICY channel_join_requests_owner_select ON public.channel_join_requests FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub') OR EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel_id = channel_join_requests.channel_id AND cm.clerk_user_id = (auth.jwt() ->> 'sub') AND cm.role = 'admin'));

DROP POLICY IF EXISTS channels_discoverable_select ON public.channels;
CREATE POLICY channels_discoverable_select ON public.channels FOR SELECT USING ((NOT is_private AND is_discoverable AND archived_at IS NULL) OR created_by = (auth.jwt() ->> 'sub') OR EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel_id = channels.id AND cm.clerk_user_id = (auth.jwt() ->> 'sub')));

DROP POLICY IF EXISTS group_join_requests_member_select ON public.group_join_requests;
CREATE POLICY group_join_requests_member_select ON public.group_join_requests FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub') OR EXISTS (SELECT 1 FROM public.conversation_members cm WHERE cm.conversation_id = group_join_requests.conversation_id AND cm.clerk_user_id = (auth.jwt() ->> 'sub') AND cm.role = 'admin'));

DROP POLICY IF EXISTS invite_links_creator_select ON public.invite_links;
CREATE POLICY invite_links_creator_select ON public.invite_links FOR SELECT USING (created_by = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS message_deletions_owner_select ON public.message_deletions;
CREATE POLICY message_deletions_owner_select ON public.message_deletions FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS message_viewers_owner_select ON public.message_viewers;
CREATE POLICY message_viewers_owner_select ON public.message_viewers FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

-- order_items no longer exists (dropped by 20260905000000_remove_workspace_make_telegram.sql
-- as part of the commerce-layer removal), so this policy would fail to create
-- on a fresh run. Guard it so the rest of this script still applies cleanly.
DO $$
BEGIN
  IF to_regclass('public.order_items') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS order_items_authenticated_select ON public.order_items';
    EXECUTE 'CREATE POLICY order_items_authenticated_select ON public.order_items FOR SELECT USING (auth.role() = ''authenticated'')';
  END IF;
END $$;

-- Note: scim_provisioning_log / organization_members no longer exist -- the
-- organization/workspace layer was intentionally dropped by
-- 20260905000000_remove_workspace_make_telegram.sql. A leftover policy for
-- scim_provisioning_log_admin_select was removed from here for that reason.

DROP POLICY IF EXISTS smart_space_rules_owner_select ON public.smart_space_rules;
CREATE POLICY smart_space_rules_owner_select ON public.smart_space_rules FOR SELECT USING (EXISTS (SELECT 1 FROM public.smart_spaces ss WHERE ss.id = smart_space_rules.space_id AND ss.owner_clerk_user_id = (auth.jwt() ->> 'sub')));

DROP POLICY IF EXISTS smart_spaces_owner_select ON public.smart_spaces;
CREATE POLICY smart_spaces_owner_select ON public.smart_spaces FOR SELECT USING (owner_clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS telegram_chat_links_owner_select ON public.telegram_chat_links;
CREATE POLICY telegram_chat_links_owner_select ON public.telegram_chat_links FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS telegram_links_owner_select ON public.telegram_links;
CREATE POLICY telegram_links_owner_select ON public.telegram_links FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS user_preferences_owner_select ON public.user_preferences;
CREATE POLICY user_preferences_owner_select ON public.user_preferences FOR SELECT USING (clerk_user_id = (auth.jwt() ->> 'sub'));

DROP POLICY IF EXISTS webhook_events_admin_select ON public.webhook_events;
CREATE POLICY webhook_events_admin_select ON public.webhook_events FOR SELECT USING (false);

DROP POLICY IF EXISTS ping_no_public_access ON public.ping;
CREATE POLICY ping_no_public_access ON public.ping FOR SELECT USING (false);

DROP POLICY IF EXISTS invoices_no_public_access ON public.invoices;
CREATE POLICY invoices_no_public_access ON public.invoices FOR SELECT USING (false);

REVOKE EXECUTE ON FUNCTION public.increment_message_view_count(uuid) FROM authenticated, anon;
