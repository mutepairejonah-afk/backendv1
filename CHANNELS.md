# Telegram-style channel architecture

Channels are **broadcast publications**, not ordinary group chats. Any authenticated user can create one directly — there's no workspace/organization to belong to first. A channel has an owner/admin set, public discovery metadata, a follower subscription, and a backing conversation used for message storage and realtime delivery.

| Capability | Backend behavior |
|---|---|
| Public discovery | `POST /api/discover-channels` searches non-private discoverable channels |
| Follow | `POST /api/follow-channel` creates a `subscriber` record and read access to the backing conversation |
| Unfollow | `POST /api/unfollow-channel` removes only the subscriber record and read access |
| Followed list | `POST /api/get-followed-channels` returns the user's subscriptions |
| Feed | `POST /api/get-channel-feed` returns paginated posts for a member/subscriber |
| Publishing | Existing message endpoints remain the write path; `assertCanPostInConversation` permits only channel admins when `is_broadcast` is enabled |
| Realtime | A subscriber joins the backing conversation room only after the backend verifies `conversation_members` access |
| Private channels | Never appear in discovery; access is granted only through an invite link or by a channel admin adding a member |
| Counts | `channels.member_count` is maintained by a database trigger over `channel_members` |

The `channel_members.role` values are `admin`, `member`, and `subscriber`. Subscribers can read but cannot publish, modify settings, add members, regenerate invites, or archive channels. The service-role backend performs Clerk authorization before every operation; Supabase migrations provide indexes and RLS protection for direct database access.

## Migration

Apply `20260901000000_add_channel_followers.sql` after the existing channel migrations. It adds stable `public_slug` values and indexes subscriber lookups. Existing channels are backfilled with collision-resistant public slugs.

`20260905000000_remove_workspace_make_telegram.sql` later drops the `channels.organization_id` column entirely (along with the whole organizations/commerce/payroll layer), so channel creation and discovery are no longer scoped to a workspace.
