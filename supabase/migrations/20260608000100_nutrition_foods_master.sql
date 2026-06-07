-- Bulk-imported snapshot of USDA FoodData Central. Loaded once
-- per release by `scripts/load-usda-foods.ts` from the public JSON
-- dumps at https://fdc.nal.usda.gov/download-datasets.html
--
-- Replaces the per-query USDA API call: the edge function's
-- `usdaSearch` now hits `search_nutrition_foods()` against this table
-- (microsecond Postgres FTS) instead of round-tripping to USDA over
-- the public internet. USDA's free tier (1000 req/hour) was a soft
-- cap; this removes it entirely.
--
-- We snapshot Foundation, SR Legacy, Survey (FNDDS), and Branded.
-- Foundation + SR Legacy are also mirrored to local SQLite so the
-- common ingredient lookups never touch the network. Branded stays
-- server-side only — 500k+ rows is too much to ship to every client.

create table public.nutrition_foods_master (
  source text not null,
  source_id text not null,
  -- Foundation | SR Legacy | Survey (FNDDS) | Branded
  data_type text not null,
  description text not null,
  brand text,
  brand_owner text,
  -- All nutrient values normalized to per-100g by the loader, so the
  -- search RPC + scaling math don't have to care about serving size.
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  saturated_fat_g numeric,
  carbs_g numeric,
  sugar_g numeric,
  fiber_g numeric,
  sodium_mg numeric,
  portions jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  -- Weighted FTS vector. Description carries the strongest signal,
  -- brand + brand_owner help disambiguate Branded entries without
  -- letting them outrank a clean Foundation/SR Legacy hit.
  search_tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(description, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(brand, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(brand_owner, '')), 'D')
  ) stored,
  primary key (source, source_id)
);

create index nutrition_foods_master_search_idx
  on public.nutrition_foods_master using gin (search_tsv);
create index nutrition_foods_master_data_type_idx
  on public.nutrition_foods_master (data_type);

alter table public.nutrition_foods_master enable row level security;

-- Reference data — every authenticated user can read it. No write
-- policy: writes go through the service-role loader only.
create policy nutrition_foods_master_read on public.nutrition_foods_master
  for select to authenticated using (true);
-- Anon read is intentional too — search is fine for unauth visitors
-- on public collection pages once we add them.
create policy nutrition_foods_master_anon_read on public.nutrition_foods_master
  for select to anon using (true);

-- The actual ranking lives here so we can iterate on the formula
-- without redeploying the edge function. `websearch_to_tsquery`
-- accepts user-style queries (quoted phrases, OR, -) and handles
-- malformed input gracefully.
create or replace function public.search_nutrition_foods(
  p_query text,
  p_limit int default 10
)
returns setof public.nutrition_foods_master
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq
  )
  select f.*
  from public.nutrition_foods_master f, q
  where q.tsq is not null
    and f.search_tsv @@ q.tsq
  order by
    -- Tier preference first; Foundation/SR Legacy beat Branded even
    -- when Branded has a higher textual rank. Mirrors the live-API
    -- tier-sort that landed in the edge function.
    case f.data_type
      when 'Foundation' then 0
      when 'SR Legacy' then 1
      when 'Survey (FNDDS)' then 2
      when 'Branded' then 3
      else 99
    end asc,
    -- USDA stores energy (nutrient 1008) as a separate row, so plenty
    -- of entries land with macros but no calories. For people tracking
    -- calories — almost everyone — an entry without kcal is nearly
    -- useless. Push the null-kcal rows down within each tier, ahead of
    -- textual relevance.
    (f.calories_kcal is null) asc,
    ts_rank_cd(f.search_tsv, q.tsq) desc,
    -- Stable tiebreaker so paginated results don't reshuffle.
    f.source_id asc
  limit greatest(p_limit, 1);
$$;

grant execute on function public.search_nutrition_foods(text, int)
  to anon, authenticated, service_role;
