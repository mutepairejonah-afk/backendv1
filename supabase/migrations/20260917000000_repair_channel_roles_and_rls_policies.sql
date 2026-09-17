-- Synchronize channel creator roles and close Supabase RLS advisor findings.

UPDATE public.conversation_members cm
SET role = 'admin'
FROM public.channels ch
WHERE ch.conversation_id = cm.conversation_id
  AND ch.created_by = cm.clerk_user_id
  AND cm.role <> 'admin';

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

DROP POLICY IF EXISTS order_items_authenticated_select ON public.order_items;
CREATE POLICY order_items_authenticated_select ON public.order_items FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS scim_provisioning_log_admin_select ON public.scim_provisioning_log;
CREATE POLICY scim_provisioning_log_admin_select ON public.scim_provisioning_log FOR SELECT USING (EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = scim_provisioning_log.organization_id AND om.clerk_user_id = (auth.jwt() ->> 'sub') AND om.role IN ('owner', 'admin')));

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
