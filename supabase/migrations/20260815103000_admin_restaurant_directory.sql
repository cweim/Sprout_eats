-- Scalable cross-user restaurant directory, detail, reviews, and save activity.
-- Expand-only migration: existing admin functions and endpoints remain available.
begin;

create index if not exists places_restaurant_created_active_idx
    on public.places (google_place_id, created_at desc)
    where deleted_at is null;

create index if not exists places_restaurant_platform_active_idx
    on public.places (google_place_id, source_platform)
    where deleted_at is null;

create index if not exists reviews_place_user_updated_idx
    on public.reviews (place_id, user_id, updated_at desc);

create or replace function public.admin_restaurant_key(
    p_google_place_id text,
    p_name text,
    p_address text
) returns text
language sql
immutable
parallel safe
as $$
    select case
        when nullif(btrim(p_google_place_id), '') is not null
            then 'google:' || btrim(p_google_place_id)
        else 'fallback:' || md5(
            lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
            || '|' ||
            lower(regexp_replace(btrim(coalesce(p_address, '')), '\s+', ' ', 'g'))
        )
    end;
$$;

create or replace function public.admin_restaurant_directory(
    p_platform text default null,
    p_city text default null,
    p_search text default null,
    p_sort text default 'saves',
    p_limit integer default 50,
    p_offset integer default 0
) returns table (
    restaurant_key text,
    google_place_id text,
    name text,
    address text,
    city text,
    cuisine text,
    save_count bigint,
    unique_savers bigint,
    visited_users bigint,
    review_count bigint,
    loved_rate numeric,
    overall_score numeric,
    adjusted_score numeric,
    food_score numeric,
    vibe_score numeric,
    value_score numeric,
    last_saved_at timestamptz,
    needs_matching boolean,
    total_count bigint
)
language sql
security definer
set search_path = public
as $$
with active_places as (
    select
        p.*,
        public.admin_restaurant_key(p.google_place_id, p.name, p.address) as restaurant_key
    from public.places p
    where p.deleted_at is null
      and (p_platform is null or p.source_platform = p_platform)
      and (p_city is null or lower(coalesce(p.city, '')) = lower(p_city))
      and (
          p_search is null or btrim(p_search) = ''
          or p.name ilike '%' || btrim(p_search) || '%'
          or coalesce(p.address, '') ilike '%' || btrim(p_search) || '%'
      )
),
place_rollup as (
    select
        p.restaurant_key,
        (array_agg(p.google_place_id order by p.created_at desc)
            filter (where p.google_place_id is not null))[1] as google_place_id,
        (array_agg(p.name order by p.created_at desc))[1] as name,
        (array_agg(p.address order by p.created_at desc)
            filter (where p.address is not null))[1] as address,
        (array_agg(p.city order by p.created_at desc)
            filter (where p.city is not null))[1] as city,
        (array_agg(p.primary_cuisine order by p.created_at desc)
            filter (where p.primary_cuisine is not null))[1] as cuisine,
        count(*) as save_count,
        count(distinct p.user_id) as unique_savers,
        count(distinct p.user_id) filter (where p.is_visited is true) as visited_users,
        max(p.created_at) as last_saved_at
    from active_places p
    group by p.restaurant_key
),
ranked_reviews as (
    select
        p.restaurant_key,
        r.user_id,
        r.sentiment,
        r.food_score,
        r.vibe_score,
        r.value_score,
        public.sprout_review_score(
            r.food_score, r.vibe_score, r.value_score, r.sentiment, r.overall_rating
        ) as score,
        row_number() over (
            partition by p.restaurant_key, r.user_id
            order by coalesce(r.updated_at, r.created_at) desc, r.id desc
        ) as review_rank
    from public.reviews r
    join active_places p on p.id = r.place_id
    where r.is_public is true
),
review_rollup as (
    select
        rr.restaurant_key,
        count(*) as review_count,
        round(
            100.0 * count(*) filter (where rr.sentiment = 'loved')
            / nullif(count(*), 0),
            1
        ) as loved_rate,
        round(avg(rr.score), 2) as overall_score,
        round(avg(rr.food_score), 2) as food_score,
        round(avg(rr.vibe_score), 2) as vibe_score,
        round(avg(rr.value_score), 2) as value_score
    from ranked_reviews rr
    where rr.review_rank = 1
    group by rr.restaurant_key
),
directory_prior as (
    select coalesce(avg(r.overall_score), 6.0) as score
    from review_rollup r
    where r.overall_score is not null
),
combined as (
    select
        p.restaurant_key,
        p.google_place_id,
        p.name,
        p.address,
        p.city,
        p.cuisine,
        p.save_count,
        p.unique_savers,
        p.visited_users,
        coalesce(r.review_count, 0) as review_count,
        coalesce(r.loved_rate, 0) as loved_rate,
        r.overall_score,
        case
            when r.overall_score is null then null
            else round(
                ((r.review_count * r.overall_score) + (5 * gp.score))
                / (r.review_count + 5),
                2
            )
        end as adjusted_score,
        r.food_score,
        r.vibe_score,
        r.value_score,
        p.last_saved_at,
        p.google_place_id is null as needs_matching,
        count(*) over () as total_count
    from place_rollup p
    cross join directory_prior gp
    left join review_rollup r using (restaurant_key)
)
select
    c.restaurant_key,
    c.google_place_id,
    c.name,
    c.address,
    c.city,
    c.cuisine,
    c.save_count,
    c.unique_savers,
    c.visited_users,
    c.review_count,
    c.loved_rate,
    c.overall_score,
    c.adjusted_score,
    c.food_score,
    c.vibe_score,
    c.value_score,
    c.last_saved_at,
    c.needs_matching,
    c.total_count
from combined c
order by
    case when p_sort = 'latest' then c.last_saved_at end desc nulls last,
    case when p_sort = 'savers' then c.unique_savers end desc nulls last,
    case when p_sort = 'visits' then c.visited_users end desc nulls last,
    case when p_sort = 'reviews' then c.review_count end desc nulls last,
    case when p_sort = 'score' then c.adjusted_score end desc nulls last,
    case when p_sort not in ('latest', 'savers', 'visits', 'reviews', 'score')
        then c.save_count end desc nulls last,
    c.save_count desc,
    c.name
limit least(greatest(p_limit, 1), 100)
offset greatest(p_offset, 0);
$$;

create or replace function public.admin_restaurant_detail(
    p_restaurant_key text
) returns jsonb
language sql
security definer
set search_path = public
as $$
with all_active_places as (
    select
        p.*,
        public.admin_restaurant_key(p.google_place_id, p.name, p.address) as restaurant_key
    from public.places p
    where p.deleted_at is null
),
target_places as (
    select * from all_active_places where restaurant_key = p_restaurant_key
),
identity as (
    select
        (array_agg(p.google_place_id order by p.created_at desc)
            filter (where p.google_place_id is not null))[1] as google_place_id,
        (array_agg(p.name order by p.created_at desc))[1] as name,
        (array_agg(p.address order by p.created_at desc)
            filter (where p.address is not null))[1] as address,
        (array_agg(p.city order by p.created_at desc)
            filter (where p.city is not null))[1] as city,
        (array_agg(p.primary_cuisine order by p.created_at desc)
            filter (where p.primary_cuisine is not null))[1] as cuisine,
        count(*) as save_count,
        count(distinct p.user_id) as unique_savers,
        count(distinct p.user_id) filter (where p.is_visited is true) as visited_users,
        min(p.created_at) as first_saved_at,
        max(p.created_at) as last_saved_at,
        count(distinct p.source_url) filter (where p.source_url is not null) as source_post_count
    from target_places p
),
target_ranked_reviews as (
    select
        r.*,
        public.sprout_review_score(
            r.food_score, r.vibe_score, r.value_score, r.sentiment, r.overall_rating
        ) as score,
        row_number() over (
            partition by r.user_id
            order by coalesce(r.updated_at, r.created_at) desc, r.id desc
        ) as review_rank
    from public.reviews r
    join target_places p on p.id = r.place_id
    where r.is_public is true
),
target_reviews as (
    select * from target_ranked_reviews where review_rank = 1
),
review_stats as (
    select
        count(*) as review_count,
        count(*) filter (where sentiment = 'loved') as loved_count,
        count(*) filter (where sentiment = 'okay') as okay_count,
        count(*) filter (where sentiment = 'meh') as meh_count,
        round(avg(score), 2) as raw_score,
        round(avg(food_score), 2) as food_score,
        round(avg(vibe_score), 2) as vibe_score,
        round(avg(value_score), 2) as value_score
    from target_reviews
),
global_ranked_reviews as (
    select
        p.restaurant_key,
        r.user_id,
        public.sprout_review_score(
            r.food_score, r.vibe_score, r.value_score, r.sentiment, r.overall_rating
        ) as score,
        row_number() over (
            partition by p.restaurant_key, r.user_id
            order by coalesce(r.updated_at, r.created_at) desc, r.id desc
        ) as review_rank
    from public.reviews r
    join all_active_places p on p.id = r.place_id
    where r.is_public is true
),
global_restaurants as (
    select restaurant_key, avg(score) as score
    from global_ranked_reviews
    where review_rank = 1 and score is not null
    group by restaurant_key
),
global_prior as (
    select coalesce(avg(score), 6.0) as score from global_restaurants
),
source_rows as (
    select
        coalesce(nullif(p.source_platform, ''), 'unknown') as source,
        count(*) as saves,
        count(distinct p.user_id) as users
    from target_places p
    group by 1
),
source_mix as (
    select coalesce(
        jsonb_agg(
            jsonb_build_object('source', source, 'saves', saves, 'users', users)
            order by saves desc, source
        ),
        '[]'::jsonb
    ) as value
    from source_rows
),
weeks as (
    select generate_series(
        date_trunc('week', now()) - interval '11 weeks',
        date_trunc('week', now()),
        interval '1 week'
    ) as week_start
),
weekly_rows as (
    select
        w.week_start,
        count(p.id) as saves,
        count(distinct p.user_id) as users
    from weeks w
    left join target_places p
      on p.created_at >= w.week_start
     and p.created_at < w.week_start + interval '1 week'
    group by w.week_start
),
weekly_saves as (
    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'week', w.week_start::date,
                'saves', w.saves,
                'users', w.users
            ) order by w.week_start
        ),
        '[]'::jsonb
    ) as value
    from weekly_rows w
),
result as (
    select jsonb_build_object(
        'restaurant_key', p_restaurant_key,
        'google_place_id', i.google_place_id,
        'name', i.name,
        'address', i.address,
        'city', i.city,
        'cuisine', i.cuisine,
        'needs_matching', i.google_place_id is null,
        'save_count', i.save_count,
        'unique_savers', i.unique_savers,
        'visited_users', i.visited_users,
        'review_count', r.review_count,
        'save_visit_rate', coalesce(i.visited_users::numeric / nullif(i.unique_savers, 0), 0),
        'visit_review_rate', coalesce(r.review_count::numeric / nullif(i.visited_users, 0), 0),
        'loved_count', r.loved_count,
        'okay_count', r.okay_count,
        'meh_count', r.meh_count,
        'loved_rate', coalesce(100.0 * r.loved_count / nullif(r.review_count, 0), 0),
        'okay_rate', coalesce(100.0 * r.okay_count / nullif(r.review_count, 0), 0),
        'meh_rate', coalesce(100.0 * r.meh_count / nullif(r.review_count, 0), 0),
        'raw_score', r.raw_score,
        'adjusted_score', case
            when r.raw_score is null then null
            else round(
                ((r.review_count * r.raw_score) + (5 * g.score))
                / (r.review_count + 5),
                2
            )
        end,
        'food_score', r.food_score,
        'vibe_score', r.vibe_score,
        'value_score', r.value_score,
        'first_saved_at', i.first_saved_at,
        'last_saved_at', i.last_saved_at,
        'source_post_count', i.source_post_count,
        'publishable', r.review_count >= 10,
        'source_mix', s.value,
        'weekly_saves', w.value
    ) as value
    from identity i
    cross join review_stats r
    cross join global_prior g
    cross join source_mix s
    cross join weekly_saves w
    where i.save_count > 0
)
select value from result;
$$;

create or replace function public.admin_restaurant_reviews(
    p_restaurant_key text,
    p_limit integer default 20,
    p_offset integer default 0
) returns table (
    review_id bigint,
    user_id bigint,
    reviewer_name text,
    sentiment text,
    food_score numeric,
    vibe_score numeric,
    value_score numeric,
    review_text text,
    reviewed_at timestamptz,
    total_count bigint
)
language sql
security definer
set search_path = public
as $$
with target_places as (
    select p.id
    from public.places p
    where p.deleted_at is null
      and public.admin_restaurant_key(p.google_place_id, p.name, p.address) = p_restaurant_key
),
ranked as (
    select
        r.*,
        row_number() over (
            partition by r.user_id
            order by coalesce(r.updated_at, r.created_at) desc, r.id desc
        ) as review_rank
    from public.reviews r
    join target_places p on p.id = r.place_id
    where r.is_public is true
),
latest as (
    select * from ranked where review_rank = 1
),
with_users as (
    select
        r.id::bigint as review_id,
        r.user_id::bigint as user_id,
        coalesce(
            nullif('@' || nullif(u.username, ''), '@'),
            nullif(u.first_name, ''),
            'User ' || r.user_id::text
        ) as reviewer_name,
        r.sentiment,
        r.food_score::numeric as food_score,
        r.vibe_score::numeric as vibe_score,
        r.value_score::numeric as value_score,
        coalesce(nullif(r.caption, ''), nullif(r.overall_remarks, '')) as review_text,
        coalesce(r.updated_at, r.created_at) as reviewed_at,
        count(*) over () as total_count
    from latest r
    left join public.users u on u.id = r.user_id
)
select
    w.review_id,
    w.user_id,
    w.reviewer_name,
    w.sentiment,
    w.food_score,
    w.vibe_score,
    w.value_score,
    w.review_text,
    w.reviewed_at,
    w.total_count
from with_users w
order by w.reviewed_at desc, w.review_id desc
limit least(greatest(p_limit, 1), 100)
offset greatest(p_offset, 0);
$$;

create or replace function public.admin_save_activity(
    p_platform text default null,
    p_city text default null,
    p_search text default null,
    p_user_id bigint default null,
    p_start timestamptz default null,
    p_end timestamptz default null,
    p_limit integer default 100,
    p_offset integer default 0
) returns table (
    place_id bigint,
    restaurant_key text,
    user_id bigint,
    user_name text,
    name text,
    address text,
    city text,
    cuisine text,
    source_platform text,
    source_url text,
    is_visited boolean,
    created_at timestamptz,
    total_count bigint
)
language sql
security definer
set search_path = public
as $$
select
    p.id::bigint as place_id,
    public.admin_restaurant_key(p.google_place_id, p.name, p.address) as restaurant_key,
    p.user_id::bigint as user_id,
    coalesce(
        nullif('@' || nullif(u.username, ''), '@'),
        nullif(u.first_name, ''),
        'User ' || p.user_id::text
    ) as user_name,
    p.name,
    p.address,
    p.city,
    p.primary_cuisine as cuisine,
    p.source_platform,
    p.source_url,
    p.is_visited,
    p.created_at,
    count(*) over () as total_count
from public.places p
left join public.users u on u.id = p.user_id
where p.deleted_at is null
  and (p_platform is null or p.source_platform = p_platform)
  and (p_city is null or lower(coalesce(p.city, '')) = lower(p_city))
  and (p_user_id is null or p.user_id = p_user_id)
  and (p_start is null or p.created_at >= p_start)
  and (p_end is null or p.created_at < p_end)
  and (
      p_search is null or btrim(p_search) = ''
      or p.name ilike '%' || btrim(p_search) || '%'
      or coalesce(p.address, '') ilike '%' || btrim(p_search) || '%'
      or coalesce(u.username, '') ilike '%' || btrim(p_search) || '%'
      or coalesce(u.first_name, '') ilike '%' || btrim(p_search) || '%'
  )
order by p.created_at desc, p.id desc
limit least(greatest(p_limit, 1), 100)
offset greatest(p_offset, 0);
$$;

revoke all on function public.admin_restaurant_key(text, text, text)
    from public, anon, authenticated;
revoke all on function public.admin_restaurant_directory(text, text, text, text, integer, integer)
    from public, anon, authenticated;
revoke all on function public.admin_restaurant_detail(text)
    from public, anon, authenticated;
revoke all on function public.admin_restaurant_reviews(text, integer, integer)
    from public, anon, authenticated;
revoke all on function public.admin_save_activity(text, text, text, bigint, timestamptz, timestamptz, integer, integer)
    from public, anon, authenticated;

grant execute on function public.admin_restaurant_key(text, text, text) to service_role;
grant execute on function public.admin_restaurant_directory(text, text, text, text, integer, integer) to service_role;
grant execute on function public.admin_restaurant_detail(text) to service_role;
grant execute on function public.admin_restaurant_reviews(text, integer, integer) to service_role;
grant execute on function public.admin_save_activity(text, text, text, bigint, timestamptz, timestamptz, integer, integer) to service_role;

commit;
