-- Structured dimensions used by admin filters and publishable Sprout insights.
begin;

alter table public.places
    add column if not exists country_code text,
    add column if not exists city text,
    add column if not exists neighborhood text,
    add column if not exists primary_cuisine text;

create index if not exists places_city_active_idx
    on public.places (city, created_at desc) where deleted_at is null;
create index if not exists places_cuisine_active_idx
    on public.places (primary_cuisine, created_at desc) where deleted_at is null;
create index if not exists places_google_place_active_idx
    on public.places (google_place_id) where deleted_at is null;

-- Deterministic normalization from Google place types. This does not guess a
-- city or neighborhood from free text and is safe to rerun.
update public.places p
set primary_cuisine = initcap(replace((
    select trim(t)
    from unnest(string_to_array(coalesce(p.place_types, ''), ',')) t
    where trim(t) like '%_restaurant'
      and trim(t) not in ('restaurant', 'fast_food_restaurant')
    limit 1
), '_restaurant', ''))
where p.primary_cuisine is null
  and exists (
      select 1 from unnest(string_to_array(coalesce(p.place_types, ''), ',')) t
      where trim(t) like '%_restaurant%'
        and trim(t) not in ('restaurant', 'fast_food_restaurant')
  );

create or replace function public.set_place_primary_cuisine()
returns trigger language plpgsql as $$
begin
    if new.primary_cuisine is null then
        select initcap(replace(trim(t), '_restaurant', '')) into new.primary_cuisine
        from unnest(string_to_array(coalesce(new.place_types, ''), ',')) t
        where trim(t) like '%_restaurant'
          and trim(t) not in ('restaurant', 'fast_food_restaurant')
        limit 1;
    end if;
    return new;
end;
$$;

drop trigger if exists places_primary_cuisine_trigger on public.places;
create trigger places_primary_cuisine_trigger
before insert or update of place_types, primary_cuisine on public.places
for each row execute function public.set_place_primary_cuisine();

commit;
