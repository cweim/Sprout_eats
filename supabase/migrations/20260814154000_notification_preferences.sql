-- User-controlled social notification preference. Existing behavior remains on by default.
alter table public.users
    add column if not exists notify_friend_activity boolean not null default true;
