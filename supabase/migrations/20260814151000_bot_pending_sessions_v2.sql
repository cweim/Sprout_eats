-- Add an isolated V2 store so one user can have multiple independent cards.
-- Apply this migration before deploying session-scoped bot callbacks.
begin;

create table if not exists public.bot_pending_sessions_v2 (
    user_id bigint not null,
    session_type text not null,
    session_id text not null,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    primary key (user_id, session_type, session_id)
);

create index if not exists bot_pending_sessions_v2_expires_at_idx
    on public.bot_pending_sessions_v2 (expires_at);

alter table public.bot_pending_sessions_v2 enable row level security;

-- Bot/API use the service role. No public policy is intentionally created.

commit;
