-- Aggregated admin analytics. Raw event and review data never leaves these
-- service-role-only functions.
begin;

create or replace function public.sprout_review_score(
    food_score integer,
    vibe_score integer,
    value_score integer,
    sentiment text,
    overall_rating integer
) returns numeric
language sql immutable
as $$
    select round(
        least(10, greatest(1,
            case
                when food_score is not null and vibe_score is not null and value_score is not null
                    then food_score * 0.4 + vibe_score * 0.3 + value_score * 0.3
                         + case sentiment when 'loved' then 0.5 when 'meh' then -0.5 else 0 end
                when food_score is not null or vibe_score is not null or value_score is not null
                    then (
                        coalesce(food_score, 0) + coalesce(vibe_score, 0) + coalesce(value_score, 0)
                    )::numeric / nullif(
                        (food_score is not null)::int + (vibe_score is not null)::int + (value_score is not null)::int,
                        0
                    ) + case sentiment when 'loved' then 0.5 when 'meh' then -0.5 else 0 end
                when sentiment = 'loved' then 8.5
                when sentiment = 'okay' then 6.0
                when sentiment = 'meh' then 3.5
                when overall_rating is not null then overall_rating * 2.0
                else null
            end
        )), 1
    );
$$;

create or replace function public.admin_analytics_snapshot(
    p_start timestamptz,
    p_end timestamptz,
    p_source text default null,
    p_city text default null
) returns jsonb
language sql
security definer
set search_path = public
as $$
with eligible_places as (
    select p.*
    from places p
    where p.deleted_at is null
      and (p_source is null or p.source_platform = p_source)
      and (p_city is null or p.city = p_city)
),
range_places as (
    select * from eligible_places where created_at >= p_start and created_at < p_end
),
mature_saves as (
    select * from range_places
    where created_at < least(p_end, now() - interval '30 days')
),
range_visits as (
    select * from eligible_places
    where is_visited is true
      and coalesce(visited_at, created_at) >= p_start
      and coalesce(visited_at, created_at) < p_end
),
range_reviews as (
    select r.*
    from reviews r join eligible_places p on p.id = r.place_id
    where coalesce(r.updated_at, r.created_at) >= p_start
      and coalesce(r.updated_at, r.created_at) < p_end
),
range_events as (
    select e.*
    from app_events e
    where e.created_at >= p_start and e.created_at < p_end
      and (p_source is null or e.event_source = p_source)
),
value_actions as (
    select user_id, created_at, event_name from range_events
    where event_name in (
        'place_saved','place_marked_visited','place_visited','review_submitted',
        'directions_clicked','reservation_clicked','map_shared','invite_sent'
    )
    union all
    select user_id, created_at, 'place_saved' from range_places where user_id is not null
    union all
    select user_id, coalesce(visited_at, created_at), 'place_visited'
    from eligible_places
    where user_id is not null and is_visited is true
      and coalesce(visited_at, created_at) >= p_start and coalesce(visited_at, created_at) < p_end
    union all
    select user_id, coalesce(updated_at, created_at), 'review_submitted' from range_reviews
),
new_users as (
    select * from users where created_at >= p_start and created_at < p_end
),
activated as (
    select distinct u.id
    from new_users u join eligible_places p on p.user_id = u.id
    where p.created_at >= u.created_at and p.created_at < u.created_at + interval '24 hours'
),
funnel_names(stage, event_names) as (values
    ('Links received', array['link_received']::text[]),
    ('Resolved', array['extraction_resolved']::text[]),
    ('Saved', array['place_saved']::text[]),
    ('Visited', array['place_visited','place_marked_visited']::text[]),
    ('Reviewed', array['review_submitted']::text[])
),
timeline_days as (
    select generate_series(
        date_trunc('day', p_start),
        date_trunc('day', p_end - interval '1 second'),
        interval '1 day'
    ) as bucket_day
),
tracking as (
    select min(created_at) first_event_at from app_events
)
select jsonb_build_object(
    'tracking_since', (select first_event_at from tracking),
    'kpis', jsonb_build_object(
        'weekly_value_users', (select count(distinct user_id) from value_actions where user_id is not null and created_at >= greatest(p_start, p_end - interval '7 days')),
        'new_users', (select count(*) from new_users),
        'activated_users', (select count(*) from activated),
        'activation_rate', coalesce((select count(*)::numeric from activated) / nullif((select count(*) from new_users), 0), 0),
        'saves', (select count(*) from range_places),
        'visits', (select count(*) from range_visits),
        'reviews', (select count(*) from range_reviews),
        'save_visit_rate', (select count(*)::numeric from mature_saves where is_visited is true and visited_at <= created_at + interval '30 days') / nullif((select count(*) from mature_saves), 0),
        'save_visit_eligible', (select count(*) from mature_saves),
        'review_completion_rate', coalesce((select count(*)::numeric from range_visits v where exists (select 1 from reviews r where r.place_id = v.id)) / nullif((select count(*) from range_visits), 0), 0),
        'qualified_intent', (
            select count(distinct concat(user_id, ':', coalesce(entity_id, metadata->>'google_place_id')))
            from range_events
            where event_name in ('directions_clicked','reservation_clicked','place_visited','place_marked_visited')
              and user_id is not null
        ),
        'extraction_success_rate', least(1, coalesce(
            (select count(distinct entity_id)::numeric from range_events where event_name = 'extraction_succeeded') /
            nullif((select count(distinct entity_id) from range_events where event_name = 'link_received'), 0), 0
        ))
    ),
    'timeline', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'date', to_char(d.bucket_day, 'YYYY-MM-DD'),
            'value_users', (select count(distinct a.user_id) from value_actions a where a.created_at >= d.bucket_day and a.created_at < d.bucket_day + interval '1 day'),
            'saves', (select count(*) from range_places p where p.created_at >= d.bucket_day and p.created_at < d.bucket_day + interval '1 day'),
            'visits', (select count(*) from eligible_places p where p.is_visited is true and coalesce(p.visited_at,p.created_at) >= d.bucket_day and coalesce(p.visited_at,p.created_at) < d.bucket_day + interval '1 day'),
            'reviews', (select count(*) from range_reviews r where coalesce(r.updated_at,r.created_at) >= d.bucket_day and coalesce(r.updated_at,r.created_at) < d.bucket_day + interval '1 day')
        ) order by d.bucket_day), '[]'::jsonb) from timeline_days d
    ),
    'funnel', (
        select jsonb_agg(jsonb_build_object(
            'stage', f.stage,
            'count', case f.stage
                when 'Saved' then (select count(*) from range_places)
                when 'Visited' then (select count(*) from range_visits)
                when 'Reviewed' then (select count(*) from range_reviews)
                else (select count(*) from range_events e where e.event_name = any(f.event_names))
            end
        )) from funnel_names f
    ),
    'sentiment', jsonb_build_object(
        'loved', (select count(*) from range_reviews where sentiment = 'loved'),
        'okay', (select count(*) from range_reviews where sentiment = 'okay'),
        'meh', (select count(*) from range_reviews where sentiment = 'meh')
    ),
    'sources', (
        select coalesce(jsonb_agg(jsonb_build_object('source', source, 'saves', saves, 'users', user_count) order by saves desc), '[]'::jsonb)
        from (
            select coalesce(source_platform, 'unknown') source, count(*) saves, count(distinct user_id) user_count
            from range_places group by 1
        ) s
    ),
    'top_cuisines', (
        select coalesce(jsonb_agg(jsonb_build_object('label', label, 'count', count) order by count desc), '[]'::jsonb)
        from (select primary_cuisine label, count(*) count from range_places where primary_cuisine is not null group by 1 order by 2 desc limit 10) c
    ),
    'top_cities', (
        select coalesce(jsonb_agg(jsonb_build_object('label', label, 'count', count) order by count desc), '[]'::jsonb)
        from (select city label, count(*) count from range_places where city is not null group by 1 order by 2 desc limit 10) c
    ),
    'failure_reasons', (
        select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'count', count) order by count desc), '[]'::jsonb)
        from (
            select reason, count(*) count from failed_extractions
            where created_at >= p_start and created_at < p_end
              and (p_source is null or platform = p_source)
            group by reason
        ) f
    )
);
$$;

create or replace function public.admin_restaurant_rankings(
    p_metric text default 'overall',
    p_city text default null,
    p_cuisine text default null,
    p_limit integer default 10,
    p_min_reviews integer default 1
) returns table (
    google_place_id text,
    name text,
    address text,
    city text,
    cuisine text,
    review_count bigint,
    loved_rate numeric,
    raw_score numeric,
    adjusted_score numeric,
    food_score numeric,
    vibe_score numeric,
    value_score numeric,
    save_count bigint,
    publishable boolean
)
language sql
security definer
set search_path = public
as $$
with ranked_reviews as (
    select
        p.google_place_id, p.name, p.address, p.city, p.primary_cuisine,
        p.user_id, r.sentiment, r.food_score, r.vibe_score, r.value_score,
        sprout_review_score(r.food_score, r.vibe_score, r.value_score, r.sentiment, r.overall_rating) score,
        row_number() over (
            partition by p.google_place_id, r.user_id
            order by coalesce(r.updated_at, r.created_at) desc, r.id desc
        ) review_rank
    from reviews r
    join places p on p.id = r.place_id
    where p.deleted_at is null
      and p.google_place_id is not null
      and r.is_public is true
      and (p_city is null or p.city = p_city)
      and (p_cuisine is null or p.primary_cuisine = p_cuisine)
),
restaurant_reviews as (
    select * from ranked_reviews where review_rank = 1
),
saves as (
    select google_place_id, count(distinct user_id) save_count
    from places
    where deleted_at is null and google_place_id is not null
    group by google_place_id
),
aggregated as (
    select
        rr.google_place_id,
        max(rr.name) name,
        max(rr.address) address,
        max(rr.city) city,
        max(rr.primary_cuisine) cuisine,
        count(*) review_count,
        round(100.0 * count(*) filter (where sentiment = 'loved') / nullif(count(*), 0), 1) loved_rate,
        round(avg(score), 2) overall_score,
        round(avg(food_score), 2) food_avg,
        round(avg(vibe_score), 2) vibe_avg,
        round(avg(value_score), 2) value_avg
    from restaurant_reviews rr
    group by rr.google_place_id
    having count(*) >= greatest(1, p_min_reviews)
),
scored as (
    select a.*, coalesce(s.save_count, 0) saves,
        case p_metric
            when 'food' then food_avg
            when 'vibe' then vibe_avg
            when 'value' then value_avg
            when 'loved' then loved_rate / 10.0
            when 'saves' then least(10, ln(1 + coalesce(s.save_count, 0)) * 3)
            else overall_score
        end metric_score
    from aggregated a left join saves s using (google_place_id)
),
global_prior as (
    select coalesce(avg(metric_score), 6.0) score from scored where metric_score is not null
)
select
    s.google_place_id, s.name, s.address, s.city, s.cuisine, s.review_count,
    s.loved_rate, s.metric_score raw_score,
    round(
        (
            ((s.review_count * coalesce(s.metric_score, 0)) + (5 * gp.score))
            / (s.review_count + 5)
        )::numeric,
        2
    ) adjusted_score,
    s.food_avg food_score, s.vibe_avg vibe_score, s.value_avg value_score,
    s.saves save_count, s.review_count >= 10 publishable
from scored s cross join global_prior gp
where s.metric_score is not null
order by adjusted_score desc, s.review_count desc, s.name
limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.admin_retention_cohorts(p_weeks integer default 8)
returns table (
    cohort_week date,
    activated_users bigint,
    d7_retained bigint,
    d30_retained bigint,
    d7_rate numeric,
    d30_rate numeric
)
language sql
security definer
set search_path = public
as $$
with cohort_users as (
    select u.id user_id, u.created_at,
           date_trunc('week', u.created_at)::date cohort_week
    from users u
    where u.created_at >= date_trunc('week', now()) - make_interval(weeks => least(greatest(p_weeks, 1), 26))
),
activated as (
    select distinct c.user_id, c.created_at, c.cohort_week
    from cohort_users c join places p on p.user_id = c.user_id
    where p.deleted_at is null
      and p.created_at >= c.created_at and p.created_at < c.created_at + interval '24 hours'
),
actions as (
    select user_id, created_at from places where deleted_at is null
    union all select user_id, coalesce(visited_at, created_at) from places where deleted_at is null and is_visited is true
    union all select user_id, coalesce(updated_at, created_at) from reviews
    union all select user_id, created_at from app_events
      where event_name in ('place_saved','place_visited','place_marked_visited','review_submitted','directions_clicked','reservation_clicked','map_shared')
)
select a.cohort_week,
       count(distinct a.user_id) activated_users,
       count(distinct a.user_id) filter (where exists (
           select 1 from actions x where x.user_id = a.user_id
             and x.created_at >= a.created_at + interval '7 days'
             and x.created_at < a.created_at + interval '14 days'
       )) d7_retained,
       count(distinct a.user_id) filter (where exists (
           select 1 from actions x where x.user_id = a.user_id
             and x.created_at >= a.created_at + interval '28 days'
             and x.created_at < a.created_at + interval '35 days'
       )) d30_retained,
       round(count(distinct a.user_id) filter (where exists (
           select 1 from actions x where x.user_id = a.user_id
             and x.created_at >= a.created_at + interval '7 days'
             and x.created_at < a.created_at + interval '14 days'
       ))::numeric / nullif(count(distinct a.user_id), 0), 4) d7_rate,
       round(count(distinct a.user_id) filter (where exists (
           select 1 from actions x where x.user_id = a.user_id
             and x.created_at >= a.created_at + interval '28 days'
             and x.created_at < a.created_at + interval '35 days'
       ))::numeric / nullif(count(distinct a.user_id), 0), 4) d30_rate
from activated a
group by a.cohort_week
order by a.cohort_week;
$$;

revoke all on function public.admin_analytics_snapshot(timestamptz,timestamptz,text,text) from public, anon, authenticated;
revoke all on function public.admin_restaurant_rankings(text,text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.admin_retention_cohorts(integer) from public, anon, authenticated;
grant execute on function public.admin_analytics_snapshot(timestamptz,timestamptz,text,text) to service_role;
grant execute on function public.admin_restaurant_rankings(text,text,text,integer,integer) to service_role;
grant execute on function public.admin_retention_cohorts(integer) to service_role;

commit;
