-- ═══════════════════════════════════════════════════════════════════════════
-- Telegram-style channels: shareable invite links, broadcast (admin-post-only)
-- channels, and instant join. Run AFTER 20260810061020_add_organizations.sql.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Invite link (like t.me/joinchat/XXXX) ────────────────────────────────────
alter table channels add column if not exists invite_code text unique default encode(gen_random_bytes(9), 'base64');
-- base64 can contain '/' and '+' which are awkward in URLs — normalize existing/defaults:
update channels set invite_code = replace(replace(invite_code, '/', '_'), '+', '-') where invite_code is not null;

-- ── Broadcast mode: true = only admins can post, members can only read
--    (this is what makes a channel behave like a Telegram "channel" rather
--    than a "group" — everyone else already gets normal groups) ────────────
alter table channels add column if not exists is_broadcast boolean not null default false;

-- ── Public directory flag: separate from is_private. A channel can be
--    "public" (findable + joinable without a link, listed in org discovery)
--    or only joinable via invite_code even if not marked private (Telegram's
--    "public channel with a link but not listed" pattern). ─────────────────
alter table channels add column if not exists is_discoverable boolean not null default true;

-- ── Subscriber count cache (avoids a COUNT(*) query on every channel list
--    render — Telegram channels can have huge member counts) ───────────────
alter table channels add column if not exists member_count integer not null default 0;

create or replace function sync_channel_member_count()
returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    update channels set member_count = member_count + 1 where id = new.channel_id;
  elsif TG_OP = 'DELETE' then
    update channels set member_count = greatest(0, member_count - 1) where id = old.channel_id;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_channel_member_count on channel_members;
create trigger trg_channel_member_count
  after insert or delete on channel_members
  for each row execute function sync_channel_member_count();

-- Backfill existing counts
update channels c set member_count = (select count(*) from channel_members cm where cm.channel_id = c.id);

create index if not exists idx_channels_invite_code on channels(invite_code);
create index if not exists idx_channels_discoverable on channels(organization_id, is_discoverable) where is_private = false;
