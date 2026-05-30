-- Nutrition analysis.
--
-- The platform calls two open-access nutrition databases — USDA
-- FoodData Central (primary, public domain) and Open Food Facts
-- (fallback, ODbL) — through the `nutrition` Edge Function. To keep
-- the round-trip-per-ingredient cost flat across users, we cache
-- whatever we fetch in `nutrition_facts_cache` keyed by
-- (source, source_id). Per-user / platform-default mappings live in
-- `ingredient_nutrition_mappings` so we don't re-search USDA every
-- time the user opens a recipe.
--
-- Why a cache vs. just hitting USDA per query: USDA's free key is
-- 1000 req/hr per IP. A single recipe with 12 ingredients × 50 users
-- viewing it in an hour already trips the limit; with a shared key
-- the math is much worse. The cache makes the second view free.
-- Open Food Facts has no key but its mirrors throttle hard.
--
-- Nutrition cache is system-wide, public-readable (it's just public-
-- domain reference data with no PII). The mappings table is per-user
-- so two cooks can disagree on what "butter" should resolve to.

-- ---------- nutrition_facts_cache ----------

create table public.nutrition_facts_cache (
  source text not null
    check (source in ('USDA_FDC', 'OPEN_FOOD_FACTS')),
  source_id text not null,
  description text not null,
  brand text,
  -- Nutrients per 100 g of the food. Always per-100g regardless of
  -- the source's native unit — we normalize on insert. NULL means the
  -- source didn't report that nutrient (which is information itself —
  -- don't paper over with zeros).
  calories_kcal numeric,
  protein_g numeric,
  fat_g numeric,
  saturated_fat_g numeric,
  carbs_g numeric,
  sugar_g numeric,
  fiber_g numeric,
  sodium_mg numeric,
  -- Optional: portion → gram weights as reported by the source (e.g.
  -- USDA's foodPortions). JSON of `{ unit: text, grams: number }`.
  -- Lets us convert recipe units we don't have in global_conversions.
  portions jsonb not null default '[]'::jsonb,
  raw_response jsonb,
  fetched_at timestamptz not null default now(),
  primary key (source, source_id)
);

create index nutrition_facts_cache_description_idx
  on public.nutrition_facts_cache using gin (to_tsvector('english', description));

alter table public.nutrition_facts_cache enable row level security;

-- Reference data. Anyone (incl. anon) can read.
create policy "nutrition_facts_read_all" on public.nutrition_facts_cache
  for select using (true);

-- Writes are service-role only (via the Edge Function). No client
-- INSERT/UPDATE/DELETE policies.

-- ---------- ingredient_nutrition_mappings ----------
--
-- Two tiers stacked: per-user override + platform default. Resolution
-- is "user row if present, else platform row, else best-effort
-- auto-search." Owner_id NULL == platform-default (only admins can
-- write null-owner rows).

create table public.ingredient_nutrition_mappings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete cascade,
  -- Normalized lowercase ingredient string (trimmed, single spaces,
  -- diacritics preserved). The frontend normalizes before lookup so
  -- "Butter " and "butter" share a mapping row.
  ingredient_key text not null,
  source text not null
    check (source in ('USDA_FDC', 'OPEN_FOOD_FACTS')),
  source_id text not null,
  -- Optional override of grams-per-recipe-unit when the source's
  -- portion data is wrong or missing. e.g. user knows their flour
  -- weighs 125g/cup, not USDA's 120g/cup.
  custom_grams_per_unit jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A given user has at most one mapping per ingredient_key; the
  -- platform default has at most one too (owner_id NULL).
  unique (owner_id, ingredient_key)
);

create index ingredient_nutrition_mappings_owner_key_idx
  on public.ingredient_nutrition_mappings(owner_id, ingredient_key);

create index ingredient_nutrition_mappings_platform_key_idx
  on public.ingredient_nutrition_mappings(ingredient_key)
  where owner_id is null;

alter table public.ingredient_nutrition_mappings enable row level security;

create policy "nutrition_mappings_self_or_platform_read" on public.ingredient_nutrition_mappings
  for select using (owner_id = auth.uid() or owner_id is null);

create policy "nutrition_mappings_self_write" on public.ingredient_nutrition_mappings
  for insert with check (owner_id = auth.uid());

create policy "nutrition_mappings_self_update" on public.ingredient_nutrition_mappings
  for update using (owner_id = auth.uid());

create policy "nutrition_mappings_self_delete" on public.ingredient_nutrition_mappings
  for delete using (owner_id = auth.uid());

-- Admins can write platform-default rows (owner_id is null).
create policy "nutrition_mappings_admin_platform_write" on public.ingredient_nutrition_mappings
  for all
  using (owner_id is null and public.is_admin(auth.uid()))
  with check (owner_id is null and public.is_admin(auth.uid()));

create trigger ingredient_nutrition_mappings_updated
  before update on public.ingredient_nutrition_mappings
  for each row execute function public.touch_updated_at();

-- ---------- Resolution helpers ----------

create or replace function public.resolve_nutrition_mapping(p_ingredient_key text)
returns table (
  source text,
  source_id text,
  custom_grams_per_unit jsonb,
  origin text  -- 'user' | 'platform' | 'none'
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is not null then
    return query
      select m.source, m.source_id, m.custom_grams_per_unit, 'user'::text
        from public.ingredient_nutrition_mappings m
        where m.owner_id = v_user and m.ingredient_key = p_ingredient_key
        limit 1;
    if found then return; end if;
  end if;
  return query
    select m.source, m.source_id, m.custom_grams_per_unit, 'platform'::text
      from public.ingredient_nutrition_mappings m
      where m.owner_id is null and m.ingredient_key = p_ingredient_key
      limit 1;
end;
$$;

grant execute on function public.resolve_nutrition_mapping(text) to authenticated, anon;

-- ---------- nutrition_kick ----------
--
-- The Edge Function is invoked synchronously from the browser
-- (per-recipe ingredient resolution is interactive, not queue-driven),
-- but we still want the platform's USDA key in Vault so it doesn't
-- live in the client bundle. Setup mirrors `import_worker_config` —
-- `nutrition_worker_config` holds `{ function_url, service_role_key,
-- usda_fdc_key }`. The first two let pg_cron / pg_net reach the
-- function for any cron-style maintenance we add later (e.g.
-- refreshing the platform-default mappings against fresher USDA data).

create or replace function public.nutrition_health()
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  cfg jsonb;
begin
  select decrypted_secret::jsonb into cfg
    from vault.decrypted_secrets
    where name = 'nutrition_worker_config'
    limit 1;
  if cfg is null then
    raise exception 'NUTRITION_WORKER_NOT_CONFIGURED: vault secret `nutrition_worker_config` is not set.'
      using errcode = 'P0001';
  end if;
  if cfg->>'function_url' is null or cfg->>'usda_fdc_key' is null then
    raise exception 'NUTRITION_WORKER_NOT_CONFIGURED: vault secret missing function_url or usda_fdc_key.'
      using errcode = 'P0001';
  end if;
  return true;
end;
$$;
grant execute on function public.nutrition_health() to authenticated;

-- ---------- Realtime publication ----------
-- Cache rows can be inserted concurrently as different users search;
-- streaming them lets one client see another's lookup land if both
-- happen to be on the same recipe at once. Mappings are user-scoped
-- so we publish them too for the per-user override UI.
alter publication supabase_realtime add table public.nutrition_facts_cache;
alter publication supabase_realtime add table public.ingredient_nutrition_mappings;
