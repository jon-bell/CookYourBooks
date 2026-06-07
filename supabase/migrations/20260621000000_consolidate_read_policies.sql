-- Consolidate the permissive SELECT RLS policies on the hot pull tables.
--
-- WHY: Postgres OR's together every PERMISSIVE policy for a command. The
-- hot pull tables (recipes + its three children) and recipe_collections
-- each carry 2-3 separate permissive SELECT policies (own/public,
-- household-library, and on recipes an admin-read). Each one is a separate
-- subplan the planner must cost on every read, and the recipes pull embeds
-- four of these tables at once, so PostgREST OR-evaluates ~11 policies
-- across the embed. That planning/eval surface (on a bloated catalog) is
-- what pushes the children pulls past the 8s `authenticated`
-- statement_timeout (57014). Collapse each table's permissive SELECT
-- policies into ONE `<table>_read` policy whose USING is the explicit OR of
-- own / public / household / (admin where it exists today). Pure cost
-- reduction; access semantics are byte-for-byte identical (RLS permissive
-- composition IS a disjunction).
--
-- INVARIANTS PRESERVED (see CLAUDE.md, 20260609 / 20260616):
--  * The household branch keeps `owner_id <> (select auth.uid())`
--    (recipes: `c.owner_id <> (select auth.uid())`) as the FIRST AND-term,
--    and the `own` branch is OR'd FIRST. So for an owner's own-row write the
--    own branch already returns true and the household_members self-join is
--    never reached -- this is what keeps Supabase Realtime delivery working
--    for the owner. DO NOT reorder so the household subquery can run for
--    self-rows.
--  * `(select auth.uid())` stays wrapped (per-query InitPlan, not per-row).
--  * The household membership test stays the NON-correlated
--    `owner_id in (select owner_m.user_id ...)` form from 20260616 -- a
--    single hoisted InitPlan, O(1) hashed membership per row. No correlated
--    EXISTS that references the outer row inside the subquery.
--  * Admin is folded ONLY into recipes_read (recipes had a dedicated
--    recipes_admin_read SELECT policy). ingredients / instructions /
--    instruction_ingredient_refs have NO admin SELECT policy today, so none
--    is added (adding one would WIDEN access).
--  * recipe_collections.collections_admin_all (FOR ALL) is LEFT UNTOUCHED --
--    it already grants admin SELECT + write; splitting it risks losing admin
--    write, so admin is NOT folded into recipe_collections_read.
--  * recipes.recipes_write_via_collection (FOR ALL) is LEFT UNTOUCHED -- its
--    SELECT footprint (collection owner) is a subset of recipes_read's own
--    branch, so it's redundant-but-safe on SELECT and keeps write semantics.
--
-- INSERT / UPDATE / DELETE policies are not touched by this migration.

-- ============================================================
-- recipe_collections   (own/public + household -> recipe_collections_read)
-- collections_admin_all (FOR ALL) stays; admin therefore NOT folded in here.
-- ============================================================
drop policy if exists "collections_read_own_or_public"     on public.recipe_collections;
drop policy if exists "collections_read_household_library" on public.recipe_collections;

create policy "recipe_collections_read" on public.recipe_collections
  for select using (
    -- own / public
    owner_id = (select auth.uid())
    or is_public
    -- household-library (short-circuit guard FIRST, non-correlated IN)
    or (
      owner_id <> (select auth.uid())
      and owner_id in (
        select owner_m.user_id
        from public.household_members owner_m
        join public.household_members viewer_m
          on viewer_m.household_id = owner_m.household_id
        where owner_m.left_at is null
          and owner_m.library_shared = true
          and viewer_m.user_id = (select auth.uid())
          and viewer_m.left_at is null
      )
    )
  );

-- ============================================================
-- recipes   (own/public-via-collection + household + admin -> recipes_read)
-- No owner_id column; everything routes through recipe_collections.
-- recipes_write_via_collection (FOR ALL) stays untouched.
-- ============================================================
drop policy if exists "recipes_read_via_collection"    on public.recipes;
drop policy if exists "recipes_read_household_library"  on public.recipes;
drop policy if exists "recipes_admin_read"              on public.recipes;

create policy "recipes_read" on public.recipes
  for select using (
    -- own / public (via collection)
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id
        and (c.owner_id = (select auth.uid()) or c.is_public)
    )
    -- household-library (collection-owner short-circuit FIRST, non-correlated IN)
    or exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id
        and c.owner_id <> (select auth.uid())
        and c.owner_id in (
          select owner_m.user_id
          from public.household_members owner_m
          join public.household_members viewer_m
            on viewer_m.household_id = owner_m.household_id
          where owner_m.left_at is null
            and owner_m.library_shared = true
            and viewer_m.user_id = (select auth.uid())
            and viewer_m.left_at is null
        )
    )
    -- admin (single hoisted InitPlan)
    or (select auth.uid()) in (select a.user_id from public.admins a)
  );

-- ============================================================
-- ingredients   (own/public-via-recipe + household -> ingredients_read)
-- Denormalized owner_id (ingredients_owner_idx). NO admin policy today.
-- ============================================================
drop policy if exists "ingredients_read_via_recipe"        on public.ingredients;
drop policy if exists "ingredients_read_household_library" on public.ingredients;

create policy "ingredients_read" on public.ingredients
  for select using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id and c.is_public
    )
    or (
      owner_id <> (select auth.uid())
      and owner_id in (
        select owner_m.user_id
        from public.household_members owner_m
        join public.household_members viewer_m
          on viewer_m.household_id = owner_m.household_id
        where owner_m.left_at is null
          and owner_m.library_shared = true
          and viewer_m.user_id = (select auth.uid())
          and viewer_m.left_at is null
      )
    )
  );

-- ============================================================
-- instructions   (own/public-via-recipe + household -> instructions_read)
-- Denormalized owner_id (instructions_owner_idx). NO admin policy today.
-- ============================================================
drop policy if exists "instructions_read_via_recipe"        on public.instructions;
drop policy if exists "instructions_read_household_library" on public.instructions;

create policy "instructions_read" on public.instructions
  for select using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id and c.is_public
    )
    or (
      owner_id <> (select auth.uid())
      and owner_id in (
        select owner_m.user_id
        from public.household_members owner_m
        join public.household_members viewer_m
          on viewer_m.household_id = owner_m.household_id
        where owner_m.left_at is null
          and owner_m.library_shared = true
          and viewer_m.user_id = (select auth.uid())
          and viewer_m.left_at is null
      )
    )
  );

-- ============================================================
-- instruction_ingredient_refs   (own/public-via-instruction + household)
-- Denormalized owner_id (instruction_ingredient_refs_owner_idx). NO admin.
-- ============================================================
drop policy if exists "iir_read_via_instruction"  on public.instruction_ingredient_refs;
drop policy if exists "iir_read_household_library" on public.instruction_ingredient_refs;

create policy "instruction_ingredient_refs_read" on public.instruction_ingredient_refs
  for select using (
    owner_id = (select auth.uid())
    or exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id and c.is_public
    )
    or (
      owner_id <> (select auth.uid())
      and owner_id in (
        select owner_m.user_id
        from public.household_members owner_m
        join public.household_members viewer_m
          on viewer_m.household_id = owner_m.household_id
        where owner_m.left_at is null
          and owner_m.library_shared = true
          and viewer_m.user_id = (select auth.uid())
          and viewer_m.left_at is null
      )
    )
  );

-- Fix #3: refresh planner stats on the hot tables. Non-locking; also makes
-- post-migration EXPLAIN plans trustworthy.
analyze public.recipes;
analyze public.recipe_collections;
analyze public.ingredients;
analyze public.instructions;
analyze public.instruction_ingredient_refs;
