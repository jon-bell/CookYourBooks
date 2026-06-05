-- Admin-side helpers for the nutrition UI.
--
-- The `nutrition_facts_cache` table is service-role-write by design
-- (the edge function is the canonical writer). For the admin tweak
-- interface — where a human curates calorie counts, portion data,
-- and the like — we expose a single security-definer RPC that the
-- /admin/nutrition page calls instead of opening up the cache table
-- to broad authenticated writes. Same posture as the moderation
-- RPCs.

create or replace function public.admin_nutrition_upsert_fact(
  p_source text,
  p_source_id text,
  p_description text,
  p_brand text default null,
  p_calories_kcal numeric default null,
  p_protein_g numeric default null,
  p_fat_g numeric default null,
  p_saturated_fat_g numeric default null,
  p_carbs_g numeric default null,
  p_sugar_g numeric default null,
  p_fiber_g numeric default null,
  p_sodium_mg numeric default null,
  p_portions jsonb default '[]'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  if p_source not in ('USDA_FDC', 'OPEN_FOOD_FACTS') then
    raise exception 'Invalid source: %', p_source using errcode = '22023';
  end if;
  insert into public.nutrition_facts_cache (
    source, source_id, description, brand,
    calories_kcal, protein_g, fat_g, saturated_fat_g,
    carbs_g, sugar_g, fiber_g, sodium_mg,
    portions, fetched_at
  )
  values (
    p_source, p_source_id, p_description, p_brand,
    p_calories_kcal, p_protein_g, p_fat_g, p_saturated_fat_g,
    p_carbs_g, p_sugar_g, p_fiber_g, p_sodium_mg,
    coalesce(p_portions, '[]'::jsonb), now()
  )
  on conflict (source, source_id) do update set
    description = excluded.description,
    brand = excluded.brand,
    calories_kcal = excluded.calories_kcal,
    protein_g = excluded.protein_g,
    fat_g = excluded.fat_g,
    saturated_fat_g = excluded.saturated_fat_g,
    carbs_g = excluded.carbs_g,
    sugar_g = excluded.sugar_g,
    fiber_g = excluded.fiber_g,
    sodium_mg = excluded.sodium_mg,
    portions = excluded.portions,
    fetched_at = now();
end;
$$;

grant execute on function public.admin_nutrition_upsert_fact(
  text, text, text, text,
  numeric, numeric, numeric, numeric,
  numeric, numeric, numeric, numeric,
  jsonb
) to authenticated;
