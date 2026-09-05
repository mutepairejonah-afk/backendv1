-- Telegram-style public channel subscriptions.
-- Subscribers are separate from channel admins/members but can still read the
-- backing conversation through a matching conversation_members row.

alter table public.channels add column if not exists public_slug text;

update public.channels
set public_slug = regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g') || '-' || substr(replace(id::text, '-', ''), 1, 8)
where public_slug is null;

create unique index if not exists channels_public_slug_uidx
  on public.channels(public_slug) where public_slug is not null;

create index if not exists channels_public_discovery_idx
  on public.channels(is_discoverable, is_private, archived_at, created_at desc);

comment on column public.channels.public_slug is 'Stable public discovery slug; the UUID suffix prevents collisions.';
comment on column public.channel_members.role is 'admin = owner/moderator, member = org/channel member, subscriber = Telegram-style follower';

create index if not exists channel_subscribers_channel_idx
  on public.channel_members(channel_id, joined_at desc)
  where role = 'subscriber';

create index if not exists channel_subscribers_user_idx
  on public.channel_members(clerk_user_id, joined_at desc)
  where role = 'subscriber';
