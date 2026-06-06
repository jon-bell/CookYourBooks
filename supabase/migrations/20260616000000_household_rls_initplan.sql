-- Household read policies: per-row household_members join -> once-per-query.
--
-- WHY: 20260611 inlined the viewer_can_read_owner_library() body into the
-- household read policies, but the inlined EXISTS is CORRELATED to each
-- row's owner_id (`owner_m.user_id = <table>.owner_id`), so it re-runs the
-- household_members self-join PER ROW when a co-member reads a shared
-- library. household_members is tiny, but it's O(rows): a member sharing a
-- large library (e.g. 16k recipes) makes the *other* member's household
-- pull do 16k per-row joins on the 512MB / fractional-CPU box -> past the
-- 8s `authenticated` statement_timeout (57014). Same shape as the
-- save_recipes_graph footgun, just latent until a shared library gets big.
--
-- FIX: the set of owners whose library the viewer may read does NOT depend
-- on the row — it's the viewer's same-household, library-sharing co-members.
-- Rewrite the correlated `EXISTS(... owner_m.user_id = <owner>)` as a
-- NON-correlated `<owner> IN (SELECT owner_m.user_id ...)`. The planner
-- hoists it to a single InitPlan (a ≤5-row list), and per row it's a hashed
-- membership test — O(1) per row instead of a join per row.
--
-- Everything else is preserved verbatim, in particular the leading
-- `owner_id <> auth.uid()` (and, for recipes, `c.owner_id <> auth.uid()`)
-- short-circuit: it must stay so the household lookup is NOT evaluated for
-- the owner's own-row changes — evaluating it there breaks Supabase
-- Realtime delivery (see 20260609 / CLAUDE.md). `(select auth.uid())` stays
-- wrapped so it's itself an InitPlan, not a per-row call.
--
-- Semantics are identical: a row is household-readable iff its owner is a
-- different, same-household, library-sharing member. Self-rows are excluded
-- by the unchanged `<> auth.uid()` guard, so it's fine that the owner set
-- may include the viewer.

-- ---------- recipe_collections ----------
drop policy if exists "collections_read_household_library" on public.recipe_collections;
create policy "collections_read_household_library" on public.recipe_collections
  for select using (
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
  );

-- ---------- recipes (no owner_id; via collection) ----------
drop policy if exists "recipes_read_household_library" on public.recipes;
create policy "recipes_read_household_library" on public.recipes
  for select using (
    exists (
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
  );

-- ---------- ingredients ----------
drop policy if exists "ingredients_read_household_library" on public.ingredients;
create policy "ingredients_read_household_library" on public.ingredients
  for select using (
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
  );

-- ---------- instructions ----------
drop policy if exists "instructions_read_household_library" on public.instructions;
create policy "instructions_read_household_library" on public.instructions
  for select using (
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
  );

-- ---------- instruction_ingredient_refs ----------
drop policy if exists "iir_read_household_library" on public.instruction_ingredient_refs;
create policy "iir_read_household_library" on public.instruction_ingredient_refs
  for select using (
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
  );
