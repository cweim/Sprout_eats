-- Opaque access keys replace guessable Telegram chat IDs in public group-map URLs.
create table if not exists public.group_map_shares (
    group_id bigint primary key,
    token text not null unique,
    created_at timestamptz not null default now()
);

create index if not exists group_map_shares_token_idx
    on public.group_map_shares (token);

alter table public.group_map_shares enable row level security;

-- The application uses the Supabase service role. No public table policy is needed.
