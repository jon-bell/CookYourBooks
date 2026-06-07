-- Claim-based RLS: resolve household + admin from JWT claims, not tables.
--
-- With household_id (20260623000100) on every shared table and the
-- household_id / is_admin claims (20260623000000) in the JWT, the read
-- policies become pure claim-vs-column compares:
--   own       : owner_id = (select auth.uid())              -- column = claim (sub)
--   household  : owner_id <> (select auth.uid())
--                and household_id = (auth.jwt() ->> 'household_id')::uuid
--   public     : exists(... is_public ...)                  -- only reached for non-own/non-household
--   admin      : coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
-- No household_members self-join, no admins lookup, no is_household_member /
-- viewer_can_read_owner_library in any of these policies.
--
-- INVARIANTS (per 20260621 / CLAUDE.md): `own` is OR'd FIRST and the
-- household branch keeps `owner_id <> (select auth.uid())` as its first
-- AND-term, so the household compare is never evaluated for an owner's own
-- row — this is what keeps Supabase Realtime delivery working. `auth.uid()`
-- stays wrapped as a per-query InitPlan.
--
-- STALENESS: existing sessions don't carry the new claims until their next
-- token refresh (≤ jwt_expiry, auto). Until then household/admin branches
-- fail closed (no over-grant). Self-initiated household transitions force a
-- refresh client-side (household/api.ts).
--
-- The is_admin() / is_household_member() functions and the admins table stay
-- (the hook + RPCs use them); they're just no longer called from these
-- policies. viewer_can_read_owner_library is now unused -> dropped.

-- Defensive: drop any superseded per-collection-share read policies from
-- 20260606000300 (already replaced by the library-wide policies, but make
-- the end state explicit so no stale is_household_member call survives).
drop policy if exists "collections_read_household"        on public.recipe_collections;
drop policy if exists "recipes_read_via_household"        on public.recipes;
drop policy if exists "ingredients_read_via_household"     on public.ingredients;
drop policy if exists "instructions_read_via_household"    on public.instructions;
drop policy if exists "iir_read_via_household"             on public.instruction_ingredient_refs;

-- ============================================================
-- recipe_collections
-- ============================================================
drop policy if exists "recipe_collections_read" on public.recipe_collections;
create policy "recipe_collections_read" on public.recipe_collections
  for select using (
    owner_id = (select auth.uid())
    or is_public
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );

-- admin FOR ALL: claim instead of an admins lookup.
drop policy if exists "collections_admin_all" on public.recipe_collections;
create policy "collections_admin_all" on public.recipe_collections
  for all
  using (coalesce((auth.jwt() ->> 'is_admin')::boolean, false))
  with check (coalesce((auth.jwt() ->> 'is_admin')::boolean, false));

-- ============================================================
-- recipes  (own/household via the new owner_id/household_id columns;
--           is_public still via the collection; admin via claim)
-- ============================================================
drop policy if exists "recipes_read" on public.recipes;
create policy "recipes_read" on public.recipes
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
    or exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id and c.is_public
    )
    or coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
  );

-- Split the FOR ALL write policy off SELECT (mirror 20260612 children). The
-- recipes_set_owner trigger stamps owner_id from the collection before the
-- WITH CHECK, so this still means "you may only write recipes in a
-- collection you own".
drop policy if exists "recipes_write_via_collection" on public.recipes;
create policy "recipes_insert_own" on public.recipes
  for insert with check (owner_id = (select auth.uid()));
create policy "recipes_update_own" on public.recipes
  for update using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "recipes_delete_own" on public.recipes
  for delete using (owner_id = (select auth.uid()));

-- ============================================================
-- ingredients / instructions / instruction_ingredient_refs
-- (own + household are column/claim; is_public kept; household before
--  is_public so the household pull skips the is_public join)
-- ============================================================
drop policy if exists "ingredients_read" on public.ingredients;
create policy "ingredients_read" on public.ingredients
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
    or exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id and c.is_public
    )
  );

drop policy if exists "instructions_read" on public.instructions;
create policy "instructions_read" on public.instructions
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
    or exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id and c.is_public
    )
  );

drop policy if exists "instruction_ingredient_refs_read" on public.instruction_ingredient_refs;
create policy "instruction_ingredient_refs_read" on public.instruction_ingredient_refs
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
    or exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id and c.is_public
    )
  );

-- ============================================================
-- cooking_events / recipe_tags — consolidate read_own + read_household
-- into one claim-based _read (own or household). Writes unchanged.
-- ============================================================
drop policy if exists "cooking_events_read_own" on public.cooking_events;
drop policy if exists "cooking_events_read_household" on public.cooking_events;
create policy "cooking_events_read" on public.cooking_events
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );

drop policy if exists "recipe_tags_read_own" on public.recipe_tags;
drop policy if exists "recipe_tags_read_household" on public.recipe_tags;
create policy "recipe_tags_read" on public.recipe_tags
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
  );

-- ============================================================
-- household tables + admin sweep — replace is_household_member / admins
-- lookups with the JWT claims.
-- ============================================================
drop policy if exists "households_read_member" on public.households;
create policy "households_read_member" on public.households
  for select using (
    id = (auth.jwt() ->> 'household_id')::uuid
    or coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
  );

drop policy if exists "households_owner_update" on public.households;
create policy "households_owner_update" on public.households
  for update using (
    owner_id = (select auth.uid())
    or coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
  );

drop policy if exists "household_members_read_same_household" on public.household_members;
create policy "household_members_read_same_household" on public.household_members
  for select using (
    user_id = (select auth.uid())
    or household_id = (auth.jwt() ->> 'household_id')::uuid
    or coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
  );

drop policy if exists "cooldowns_self_read" on public.household_join_cooldowns;
create policy "cooldowns_self_read" on public.household_join_cooldowns
  for select using (
    user_id = (select auth.uid())
    or coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
  );

drop policy if exists "household_ocr_config_read_member" on public.household_ocr_config;
create policy "household_ocr_config_read_member" on public.household_ocr_config
  for select using (
    household_id = (auth.jwt() ->> 'household_id')::uuid
    or coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
  );

drop policy if exists "household_ocr_config_owner_update" on public.household_ocr_config;
create policy "household_ocr_config_owner_update" on public.household_ocr_config
  for update using (
    household_id in (select id from public.households where owner_id = (select auth.uid()))
    or coalesce((auth.jwt() ->> 'is_admin')::boolean, false)
  );

drop policy if exists "nutrition_mappings_admin_platform_write" on public.ingredient_nutrition_mappings;
create policy "nutrition_mappings_admin_platform_write" on public.ingredient_nutrition_mappings
  for all
  using (owner_id is null and coalesce((auth.jwt() ->> 'is_admin')::boolean, false))
  with check (owner_id is null and coalesce((auth.jwt() ->> 'is_admin')::boolean, false));

-- viewer_can_read_owner_library is no longer referenced by any policy.
drop function if exists public.viewer_can_read_owner_library(uuid);

analyze public.recipes;
analyze public.recipe_collections;
analyze public.ingredients;
analyze public.instructions;
analyze public.instruction_ingredient_refs;
analyze public.cooking_events;
analyze public.recipe_tags;
