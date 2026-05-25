-- House conversion rules: free-form notes column.
--
-- Users can attach context to a rule ("my 8oz cup", "wholewheat flour
-- only", "weighed on the kitchen scale 2026-05"). Mirrors the
-- `notes` column already on `global_conversions`.

alter table public.conversion_rules
  add column if not exists notes text;

-- Replace the upsert RPC so it accepts and persists the notes field.
-- Postgres routes by argument list, so the old (uuid,text,text,numeric,text)
-- signature is dropped first to avoid an "ambiguous function" overload.

drop function if exists public.house_conversion_upsert(uuid, text, text, numeric, text);

create or replace function public.house_conversion_upsert(
  p_id uuid,
  p_from_unit text,
  p_to_unit text,
  p_factor numeric,
  p_ingredient_name text,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  trimmed_ingredient text := nullif(trim(lower(coalesce(p_ingredient_name, ''))), '');
  trimmed_from text := lower(trim(coalesce(p_from_unit, '')));
  trimmed_to text := lower(trim(coalesce(p_to_unit, '')));
  trimmed_notes text := nullif(trim(coalesce(p_notes, '')), '');
  result_id uuid;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if trimmed_from = '' or trimmed_to = '' then
    raise exception 'from_unit and to_unit are required' using errcode = '22023';
  end if;
  if p_factor is null or p_factor <= 0 or not (p_factor = p_factor) then
    raise exception 'factor must be a positive number' using errcode = '22023';
  end if;

  insert into public.conversion_rules
    (id, owner_id, recipe_id, from_unit, to_unit, factor,
     ingredient_name, priority, notes)
  values
    (coalesce(p_id, gen_random_uuid()), caller, null, trimmed_from,
     trimmed_to, p_factor, trimmed_ingredient, 'HOUSE', trimmed_notes)
  on conflict (id) do update
    set from_unit = excluded.from_unit,
        to_unit = excluded.to_unit,
        factor = excluded.factor,
        ingredient_name = excluded.ingredient_name,
        notes = excluded.notes,
        recipe_id = null,
        priority = 'HOUSE'
    where public.conversion_rules.owner_id = caller
  returning id into result_id;

  if result_id is null then
    raise exception 'Rule not owned by caller' using errcode = '42501';
  end if;
  return result_id;
end;
$$;

revoke all on function public.house_conversion_upsert(uuid, text, text, numeric, text, text) from public;
grant execute on function public.house_conversion_upsert(uuid, text, text, numeric, text, text) to authenticated;
