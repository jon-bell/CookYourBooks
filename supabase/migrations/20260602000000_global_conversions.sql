-- House + Global conversions.
--
-- Adds an admin-editable `global_conversions` table that ships with
-- sensible densities and piece-to-gram defaults, plus the missing
-- timestamps on `conversion_rules` so per-user HOUSE rules can sync
-- via the existing watermarked pull. Also broadens the priority
-- CHECK so a future tier doesn't trip the constraint.

-- ---------- Extend conversion_rules ----------

alter table public.conversion_rules
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists conversion_rules_owner_updated_idx
  on public.conversion_rules(owner_id, updated_at);

-- Broaden the existing check constraint to also allow GLOBAL. We
-- don't write GLOBAL rows into this table — globals live in their
-- own table below — but rejecting the literal value here would mean
-- any future migration that wanted to cross-reference the union
-- would have to fight the constraint.
alter table public.conversion_rules
  drop constraint if exists conversion_rules_priority_check;
alter table public.conversion_rules
  add constraint conversion_rules_priority_check
  check (priority in ('HOUSE', 'RECIPE', 'STANDARD', 'GLOBAL'));

drop trigger if exists conversion_rules_updated on public.conversion_rules;
create trigger conversion_rules_updated
  before update on public.conversion_rules
  for each row execute function public.touch_updated_at();

alter publication supabase_realtime add table public.conversion_rules;

-- ---------- global_conversions ----------

create table public.global_conversions (
  id uuid primary key default gen_random_uuid(),
  from_unit text not null,
  to_unit text not null,
  factor numeric not null check (factor > 0),
  ingredient_name text,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Treat NULL ingredient_name as a sentinel for "generic rule"; a
  -- coalesce in the unique constraint lets us still forbid duplicate
  -- generics per (from, to).
  unique (from_unit, to_unit, ingredient_name)
);

create index global_conversions_ingredient_idx
  on public.global_conversions(lower(coalesce(ingredient_name, '')));

alter table public.global_conversions enable row level security;

-- Anyone signed in can read the table; writes are mediated only
-- through the admin RPCs below (which check is_admin()). No row-level
-- write policy = no row-level writes possible from a regular caller.
create policy "global_conversions_read" on public.global_conversions
  for select to authenticated using (true);

create trigger global_conversions_updated
  before update on public.global_conversions
  for each row execute function public.touch_updated_at();

alter publication supabase_realtime add table public.global_conversions;

-- ---------- Seed densities + piece-to-gram defaults ----------
--
-- These are conservative starting points so the very first sync
-- delivers a useful conversion experience. Admins can edit any of
-- them; we don't carry a "factory default" snapshot.

insert into public.global_conversions (from_unit, to_unit, factor, ingredient_name, notes) values
  ('milliliter', 'gram', 1.00, 'water',  'water reference at 4°C'),
  ('milliliter', 'gram', 1.03, 'milk',   'whole milk'),
  ('milliliter', 'gram', 0.92, 'oil',    'neutral vegetable oil'),
  ('milliliter', 'gram', 0.91, 'butter', 'melted'),
  ('milliliter', 'gram', 1.42, 'honey',  null),
  ('milliliter', 'gram', 0.53, 'flour',  'all-purpose, sifted'),
  ('milliliter', 'gram', 0.85, 'sugar',  'granulated white'),
  ('piece',      'gram', 240,  'onion',  'medium yellow'),
  ('piece',      'gram', 50,   'egg',    'large, in-shell ~58g; without shell ~50g'),
  ('clove',      'gram', 5,    'garlic', null);

-- ---------- RPCs ----------

-- house_conversion_upsert: insert or update the caller's own HOUSE
-- rule. Returns the row id. Owner_id is pinned to auth.uid() so a
-- spoofed payload can't write under someone else.
create or replace function public.house_conversion_upsert(
  p_id uuid,
  p_from_unit text,
  p_to_unit text,
  p_factor numeric,
  p_ingredient_name text
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

  -- Client mints UUIDs locally (cr-sqlite needs ids on insert before
  -- the row can be saved offline), so we want a real upsert: insert
  -- if the row doesn't exist, update if it does — but only if it's
  -- already owned by the caller. The WHERE clause on the conflict
  -- branch prevents one user from clobbering another's row by
  -- guessing their UUID. A null `result_id` after the statement means
  -- a conflict landed on a row owned by someone else: surface as 42501.
  insert into public.conversion_rules
    (id, owner_id, recipe_id, from_unit, to_unit, factor,
     ingredient_name, priority)
  values
    (coalesce(p_id, gen_random_uuid()), caller, null, trimmed_from,
     trimmed_to, p_factor, trimmed_ingredient, 'HOUSE')
  on conflict (id) do update
    set from_unit = excluded.from_unit,
        to_unit = excluded.to_unit,
        factor = excluded.factor,
        ingredient_name = excluded.ingredient_name,
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

revoke all on function public.house_conversion_upsert(uuid, text, text, numeric, text) from public;
grant execute on function public.house_conversion_upsert(uuid, text, text, numeric, text) to authenticated;

create or replace function public.house_conversion_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  deleted_count int;
begin
  if caller is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  delete from public.conversion_rules
   where id = p_id and owner_id = caller;
  get diagnostics deleted_count = row_count;
  if deleted_count = 0 then
    raise exception 'Rule not found or not owned by caller' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.house_conversion_delete(uuid) from public;
grant execute on function public.house_conversion_delete(uuid) to authenticated;

-- global_conversion_upsert / delete: admin only.

create or replace function public.global_conversion_upsert(
  p_id uuid,
  p_from_unit text,
  p_to_unit text,
  p_factor numeric,
  p_ingredient_name text,
  p_notes text
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
      (from_unit, to_unit, factor, ingredient_name, notes, created_by, updated_by)
    values
      (trimmed_from, trimmed_to, p_factor, trimmed_ingredient, trimmed_notes, caller, caller)
    returning id into result_id;
  else
    update public.global_conversions
       set from_unit = trimmed_from,
           to_unit = trimmed_to,
           factor = p_factor,
           ingredient_name = trimmed_ingredient,
           notes = trimmed_notes,
           updated_by = caller
     where id = p_id
    returning id into result_id;
    if result_id is null then
      raise exception 'Global rule not found' using errcode = '22023';
    end if;
  end if;

  return result_id;
end;
$$;

revoke all on function public.global_conversion_upsert(uuid, text, text, numeric, text, text) from public;
grant execute on function public.global_conversion_upsert(uuid, text, text, numeric, text, text) to authenticated;

create or replace function public.global_conversion_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  deleted_count int;
begin
  if caller is null or not public.is_admin(caller) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;
  delete from public.global_conversions where id = p_id;
  get diagnostics deleted_count = row_count;
  if deleted_count = 0 then
    raise exception 'Global rule not found' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.global_conversion_delete(uuid) from public;
grant execute on function public.global_conversion_delete(uuid) to authenticated;
