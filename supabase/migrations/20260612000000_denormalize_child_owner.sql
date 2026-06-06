-- Denormalize owner_id onto the recipe child tables + split write policies.
--
-- Even after 20260611000000 inlined the RLS helper functions, the child
-- read policies still did an EXISTS(recipes JOIN recipe_collections ...)
-- PER ROW. On a full-library pull that's one join per child row — ~227ms
-- for a 50k-instruction owner pull measured locally, which tips over the
-- statement_timeout on prod's 512MB / fractional-CPU box.
--
-- Fix: carry owner_id directly on each child table so the read policy is
-- a column compare (`owner_id = (select auth.uid())`) with NO join — 50k
-- per-row joins become 50k integer compares. owner_id is kept correct by
-- a BEFORE INSERT/UPDATE trigger that derives it from the row's recipe ->
-- collection owner (SECURITY DEFINER, so it sees through RLS), plus a
-- one-time backfill. The write policies' WITH CHECK then becomes
-- `owner_id = (select auth.uid())`: the trigger runs first, so this still
-- means "you may only write children of recipes in a collection you own".
--
-- Also splits the old `*_write_via_recipe` FOR ALL policies into
-- INSERT/UPDATE/DELETE so their USING is no longer evaluated on SELECT
-- (it was a strict subset of the read policy — pure redundant work).
--
-- SERVER-ONLY: the browser's cr-sqlite upserts and the outbox push both
-- use explicit column lists, so this extra column is ignored client-side.

-- ============================================================
-- 1. Columns
-- ============================================================
alter table public.ingredients add column if not exists owner_id uuid;
alter table public.instructions add column if not exists owner_id uuid;
alter table public.instruction_ingredient_refs add column if not exists owner_id uuid;

-- ============================================================
-- 2. Backfill from the recipe -> collection chain
-- ============================================================
update public.ingredients i
   set owner_id = c.owner_id
  from public.recipes r
  join public.recipe_collections c on c.id = r.collection_id
 where r.id = i.recipe_id
   and i.owner_id is distinct from c.owner_id;

update public.instructions ins
   set owner_id = c.owner_id
  from public.recipes r
  join public.recipe_collections c on c.id = r.collection_id
 where r.id = ins.recipe_id
   and ins.owner_id is distinct from c.owner_id;

update public.instruction_ingredient_refs ref
   set owner_id = c.owner_id
  from public.instructions ins
  join public.recipes r on r.id = ins.recipe_id
  join public.recipe_collections c on c.id = r.collection_id
 where ins.id = ref.instruction_id
   and ref.owner_id is distinct from c.owner_id;

-- ============================================================
-- 3. Keep owner_id populated on write
-- ============================================================
-- Children keyed off recipe_id (ingredients, instructions).
create or replace function public.set_child_owner_from_recipe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select c.owner_id into new.owner_id
    from public.recipes r
    join public.recipe_collections c on c.id = r.collection_id
   where r.id = new.recipe_id;
  return new;
end;
$$;

drop trigger if exists ingredients_set_owner on public.ingredients;
create trigger ingredients_set_owner
  before insert or update of recipe_id on public.ingredients
  for each row execute function public.set_child_owner_from_recipe();

drop trigger if exists instructions_set_owner on public.instructions;
create trigger instructions_set_owner
  before insert or update of recipe_id on public.instructions
  for each row execute function public.set_child_owner_from_recipe();

-- Refs keyed off instruction_id.
create or replace function public.set_ref_owner_from_instruction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select c.owner_id into new.owner_id
    from public.instructions ins
    join public.recipes r on r.id = ins.recipe_id
    join public.recipe_collections c on c.id = r.collection_id
   where ins.id = new.instruction_id;
  return new;
end;
$$;

drop trigger if exists iir_set_owner on public.instruction_ingredient_refs;
create trigger iir_set_owner
  before insert or update of instruction_id on public.instruction_ingredient_refs
  for each row execute function public.set_ref_owner_from_instruction();

-- If a recipe ever moves to a different collection, cascade the new owner
-- to its children (rare, but keeps the denormalized column honest).
create or replace function public.sync_children_owner_on_recipe_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if new.collection_id is distinct from old.collection_id then
    select owner_id into v_owner from public.recipe_collections where id = new.collection_id;
    update public.ingredients set owner_id = v_owner where recipe_id = new.id;
    update public.instructions set owner_id = v_owner where recipe_id = new.id;
    update public.instruction_ingredient_refs ref
       set owner_id = v_owner
      from public.instructions ins
     where ins.id = ref.instruction_id and ins.recipe_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists recipes_sync_children_owner on public.recipes;
create trigger recipes_sync_children_owner
  after update of collection_id on public.recipes
  for each row execute function public.sync_children_owner_on_recipe_move();

-- ============================================================
-- 4. Indexes on the new column
-- ============================================================
create index if not exists ingredients_owner_idx on public.ingredients(owner_id);
create index if not exists instructions_owner_idx on public.instructions(owner_id);
create index if not exists instruction_ingredient_refs_owner_idx
  on public.instruction_ingredient_refs(owner_id);

-- ============================================================
-- 5. Rewrite RLS — own-row branch is now a join-free column compare.
--    is_public branch still joins (only reached for non-owned rows, which
--    short-circuit on the owner_id compare). Household branch matches the
--    child's own owner_id directly (no recipe/collection join).
-- ============================================================

-- ---------- ingredients ----------
drop policy if exists "ingredients_read_via_recipe" on public.ingredients;
create policy "ingredients_read_via_recipe" on public.ingredients
  for select using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id and c.is_public
    )
  );

drop policy if exists "ingredients_read_household_library" on public.ingredients;
create policy "ingredients_read_household_library" on public.ingredients
  for select using (
    owner_id <> (select auth.uid())
    and exists (
      select 1
      from public.household_members owner_m
      join public.household_members viewer_m
        on viewer_m.household_id = owner_m.household_id
      where owner_m.user_id = ingredients.owner_id
        and owner_m.left_at is null
        and owner_m.library_shared = true
        and viewer_m.user_id = (select auth.uid())
        and viewer_m.left_at is null
    )
  );

-- Split the old FOR ALL write policy off SELECT.
drop policy if exists "ingredients_write_via_recipe" on public.ingredients;
create policy "ingredients_insert_own" on public.ingredients
  for insert with check (owner_id = (select auth.uid()));
create policy "ingredients_update_own" on public.ingredients
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "ingredients_delete_own" on public.ingredients
  for delete using (owner_id = (select auth.uid()));

-- ---------- instructions ----------
drop policy if exists "instructions_read_via_recipe" on public.instructions;
create policy "instructions_read_via_recipe" on public.instructions
  for select using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id and c.is_public
    )
  );

drop policy if exists "instructions_read_household_library" on public.instructions;
create policy "instructions_read_household_library" on public.instructions
  for select using (
    owner_id <> (select auth.uid())
    and exists (
      select 1
      from public.household_members owner_m
      join public.household_members viewer_m
        on viewer_m.household_id = owner_m.household_id
      where owner_m.user_id = instructions.owner_id
        and owner_m.left_at is null
        and owner_m.library_shared = true
        and viewer_m.user_id = (select auth.uid())
        and viewer_m.left_at is null
    )
  );

drop policy if exists "instructions_write_via_recipe" on public.instructions;
create policy "instructions_insert_own" on public.instructions
  for insert with check (owner_id = (select auth.uid()));
create policy "instructions_update_own" on public.instructions
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "instructions_delete_own" on public.instructions
  for delete using (owner_id = (select auth.uid()));

-- ---------- instruction_ingredient_refs ----------
drop policy if exists "iir_read_via_instruction" on public.instruction_ingredient_refs;
create policy "iir_read_via_instruction" on public.instruction_ingredient_refs
  for select using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id and c.is_public
    )
  );

drop policy if exists "iir_read_household_library" on public.instruction_ingredient_refs;
create policy "iir_read_household_library" on public.instruction_ingredient_refs
  for select using (
    owner_id <> (select auth.uid())
    and exists (
      select 1
      from public.household_members owner_m
      join public.household_members viewer_m
        on viewer_m.household_id = owner_m.household_id
      where owner_m.user_id = instruction_ingredient_refs.owner_id
        and owner_m.left_at is null
        and owner_m.library_shared = true
        and viewer_m.user_id = (select auth.uid())
        and viewer_m.left_at is null
    )
  );

drop policy if exists "iir_write_via_instruction" on public.instruction_ingredient_refs;
create policy "iir_insert_own" on public.instruction_ingredient_refs
  for insert with check (owner_id = (select auth.uid()));
create policy "iir_update_own" on public.instruction_ingredient_refs
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "iir_delete_own" on public.instruction_ingredient_refs
  for delete using (owner_id = (select auth.uid()));
