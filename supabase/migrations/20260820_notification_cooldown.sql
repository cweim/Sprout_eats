-- Per (actor, recipient) cooldown tracking for friend activity notifications.
-- Saves fire only once per cooldown window; reviews/visits always go through.
create table if not exists public.notification_cooldown (
    actor_user_id     bigint not null,
    recipient_user_id bigint not null,
    last_notified_at  timestamptz not null default now(),
    primary key (actor_user_id, recipient_user_id)
);
