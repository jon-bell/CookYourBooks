-- Make RPC argument nullability explicit so `supabase gen types
-- typescript --local` emits accurate TypeScript types.
--
-- Background: the Supabase CLI maps function arg defaults to TS
-- optionality. `text` becomes `string` (required, non-nullable);
-- `text default null` becomes `string?` (optional, droppable).
-- Without `default null` on params whose bodies coalesce / null-check,
-- the generated TS types disagree with the runtime contract and
-- frontend `p_x: value ?? null` calls fail typecheck.
--
-- Fix: re-declare the affected functions with `default null` on the
-- params their bodies already treat as nullable. Bodies unchanged.
-- Callers pass `value ?? undefined` (which JSON.stringify drops) so
-- the server applies the DEFAULT.
--
-- Postgres rule: defaulted params must come after non-defaulted ones.
-- house_conversion_upsert's existing order already satisfies that, so
-- a simple `create or replace` suffices. global_conversion_upsert has
-- the nullable p_id at position 1, so we have to DROP + CREATE with a
-- reordered signature. No internal PG callers exist for either, so
-- the reorder is safe.

-- ---------- house_conversion_upsert ----------
-- p_ingredient_name is the only currently-required-but-actually-nullable
-- param (body coalesces it). p_notes was already default-null in the
-- 20260602100000 redefine. Adding the default in place keeps the same
-- signature so `create or replace` works.

create or replace function public.house_conversion_upsert(
  p_id uuid,
  p_from_unit text,
  p_to_unit text,
  p_factor numeric,
  p_ingredient_name text default null,
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
begin
  if caller is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'p_id is required' using errcode = '22023';
  end if;
  if trimmed_from = '' or trimmed_to = '' then
    raise exception 'from_unit and to_unit are required' using errcode = '22023';
  end if;
  if p_factor is null or p_factor <= 0 or not (p_factor = p_factor) then
    raise exception 'factor must be a positive number' using errcode = '22023';
  end if;
  insert into public.conversion_rules
    (id, owner_id, from_unit, to_unit, factor, ingredient_name, notes, priority)
    values (p_id, caller, trimmed_from, trimmed_to, p_factor, trimmed_ingredient, trimmed_notes, 'HOUSE')
    on conflict (id) do update
      set from_unit = excluded.from_unit,
          to_unit = excluded.to_unit,
          factor = excluded.factor,
          ingredient_name = excluded.ingredient_name,
          notes = excluded.notes
      where conversion_rules.owner_id = caller;
  return p_id;
end;
$$;

-- ---------- global_conversion_upsert ----------
-- Body explicitly handles p_id IS NULL (means "insert new"). Reorder
-- the signature so the nullable params trail the required ones.
-- Required (no default): p_from_unit, p_to_unit, p_factor.
-- Nullable (default null): p_id, p_ingredient_name, p_notes.

drop function if exists public.global_conversion_upsert(uuid, text, text, numeric, text, text);

create or replace function public.global_conversion_upsert(
  p_from_unit text,
  p_to_unit text,
  p_factor numeric,
  p_id uuid default null,
  p_ingredient_name text default null,
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
  if caller is null or not public.is_admin(caller) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  if trimmed_from = '' or trimmed_to = '' then
    raise exception 'from_unit and to_unit are required' using errcode = '22023';
  end if;
  if p_factor is null or p_factor <= 0 or not (p_factor = p_factor) then
    raise exception 'factor must be a positive number' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.global_conversions
      (from_unit, to_unit, factor, ingredient_name, notes)
      values (trimmed_from, trimmed_to, p_factor, trimmed_ingredient, trimmed_notes)
      returning id into result_id;
  else
    update public.global_conversions
       set from_unit = trimmed_from,
           to_unit = trimmed_to,
           factor = p_factor,
           ingredient_name = trimmed_ingredient,
           notes = trimmed_notes,
           updated_at = now()
     where id = p_id
     returning id into result_id;
    if result_id is null then
      raise exception 'global_conversion not found' using errcode = 'P0002';
    end if;
  end if;
  return result_id;
end;
$$;
revoke all on function public.global_conversion_upsert(text, text, numeric, uuid, text, text) from public, anon;
grant execute on function public.global_conversion_upsert(text, text, numeric, uuid, text, text) to authenticated;

-- bakeoff_start.p_image_storage_path stays required in the signature.
-- The OCR path needs a non-null string anyway, and the REWRITE path
-- accepts any value (we always insert null into the column for that
-- task). The frontend coerces null → '' at the call site rather than
-- declaring the param nullable, because doing so would require
-- reordering args around the required p_variants.
