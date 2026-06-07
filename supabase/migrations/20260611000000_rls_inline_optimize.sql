-- RLS inline + index optimization (production hang remediation).
--
-- Incident: every PostgREST query hung (~12s+) and the connection pool
-- starved after a bulk import grew the recipe tables. Root cause: RLS
-- policies called non-inlinable PL/pgSQL-or-SQL SECURITY DEFINER helper
-- functions (`viewer_can_read_owner_library`, `is_admin`,
-- `is_household_member`) and bare `auth.uid()` directly in their
-- USING / WITH CHECK expressions. Postgres treats a volatile-or-opaque
-- function reference in a row predicate as something it must evaluate
-- PER ROW, so each of those calls fanned out across the whole table —
-- pathological as the tables grew.
--
-- This migration rewrites every offending policy so the planner can
-- hoist the expensive work out of the per-row loop:
--   1. NO function calls in USING / WITH CHECK except Supabase built-ins
--      (`auth.uid()`), and even those are wrapped as `(select auth.uid())`
--      so they evaluate ONCE via an InitPlan instead of once per row.
--   2. SECURITY DEFINER helper calls are inlined as `EXISTS (...)`
--      correlated subqueries the planner can fold into a single hashed
--      SubPlan (verified via EXPLAIN: the household predicate collapses
--      to `owner_id = ANY (hashed SubPlan)`, evaluated once per
--      statement).
--   3. Every column a policy predicate now joins/subselects on is backed
--      by an index (most already existed from earlier migrations; the
--      `if not exists` guards below are belt-and-suspenders + document
--      the dependency).
--
-- The SECURITY DEFINER helpers (`is_admin`, `is_household_member`,
-- `viewer_can_read_owner_library`, `current_household_id`) are KEPT
-- DEFINED — RPCs and triggers still call them. They are simply no longer
-- referenced from the policies that could be inlined safely.
--
-- TWO policies deliberately RETAIN a SECURITY DEFINER call because
-- inlining them recurses (a table whose policy subselects itself):
--   * `household_members.household_members_read_same_household`
--   * `admins.admins_self_or_admin_read`  (and the admin write policies)
-- For these we still wrap `auth.uid()` in `(select ...)`; the function
-- calls cannot be removed without "infinite recursion detected in policy"
-- (this is exactly why those helpers were made SECURITY DEFINER). See the
-- per-policy notes below.
--
-- CRITICAL invariant preserved: every household-library read policy keeps
-- the cheap `owner_id <> (select auth.uid())` short-circuit FIRST, so the
-- household subquery is never reached for the owner's own rows. Per
-- 20260609000000, evaluating that branch for an owner's own-row change
-- breaks Supabase Realtime delivery. Access semantics are unchanged —
-- each rewrite is logically equivalent to the policy it replaces (see the
-- "old vs new" note on each).

-- ============================================================
-- Indexes backing RLS predicates (idempotent).
-- ============================================================
-- recipe_collections: owner_id (own + household), is_public (public read).
create index if not exists recipe_collections_owner_idx
  on public.recipe_collections(owner_id);
create index if not exists recipe_collections_public_idx
  on public.recipe_collections(is_public) where is_public;
-- recipes / ingredients / instructions: the FK columns the policies walk.
create index if not exists recipes_collection_idx
  on public.recipes(collection_id);
create index if not exists ingredients_recipe_idx
  on public.ingredients(recipe_id);
create index if not exists instructions_recipe_idx
  on public.instructions(recipe_id);
-- instruction_ingredient_refs: instruction_id is the leading column of the
-- composite PK (instruction_id, ingredient_id), so PK serves the lookup;
-- add an explicit single-column index in case the PK column order changes.
create index if not exists instruction_ingredient_refs_instruction_idx
  on public.instruction_ingredient_refs(instruction_id);
-- household_members: the active-membership lookups the household subqueries
-- run. The partial unique index on (user_id) WHERE left_at is null already
-- serves the "caller's own active row" lookup; (household_id) serves the
-- "active members of this household" lookup.
create index if not exists household_members_user_idx
  on public.household_members(user_id);
create index if not exists household_members_household_idx
  on public.household_members(household_id);
create index if not exists household_members_active_idx
  on public.household_members(user_id) where left_at is null;
-- admins: PK on (user_id) already serves the inlined is_admin lookups.

-- ============================================================
-- recipe_collections
-- ============================================================
-- Own/public read: was `(owner_id = auth.uid()) OR is_public`.
-- New wraps auth.uid(); semantics identical.
drop policy if exists "collections_read_own_or_public" on public.recipe_collections;
create policy "collections_read_own_or_public" on public.recipe_collections
  for select using (
    owner_id = (select auth.uid()) or is_public
  );

-- Household-library read: was
--   `(owner_id <> auth.uid()) AND viewer_can_read_owner_library(owner_id)`.
-- New inlines the helper body verbatim as an EXISTS over household_members.
-- Equivalence: the helper returns true iff the owner is an active,
-- library_shared member of a household the caller is also an active member
-- of (and owner <> caller). The subquery encodes exactly that. The
-- `owner_id <> (select auth.uid())` short-circuit is preserved FIRST so the
-- subquery is never evaluated for the owner's own rows (realtime invariant).
drop policy if exists "collections_read_household_library" on public.recipe_collections;
create policy "collections_read_household_library" on public.recipe_collections
  for select using (
    owner_id <> (select auth.uid())
    and exists (
      select 1
      from public.household_members owner_m
      join public.household_members viewer_m
        on viewer_m.household_id = owner_m.household_id
      where owner_m.user_id = recipe_collections.owner_id
        and owner_m.left_at is null
        and owner_m.library_shared = true
        and viewer_m.user_id = (select auth.uid())
        and viewer_m.left_at is null
    )
  );

-- Admin all: was `is_admin(auth.uid())`. Inlined as EXISTS on admins
-- (recursion-safe: admins is a different table from recipe_collections;
-- reading the caller's own admin row is permitted by admins' own policy
-- without re-entering is_admin).
drop policy if exists "collections_admin_all" on public.recipe_collections;
create policy "collections_admin_all" on public.recipe_collections
  for all
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

-- Write/insert/update/delete own: bare auth.uid() -> wrapped.
drop policy if exists "collections_insert_own" on public.recipe_collections;
create policy "collections_insert_own" on public.recipe_collections
  for insert with check (owner_id = (select auth.uid()));
drop policy if exists "collections_update_own" on public.recipe_collections;
create policy "collections_update_own" on public.recipe_collections
  for update using (owner_id = (select auth.uid()));
drop policy if exists "collections_delete_own" on public.recipe_collections;
create policy "collections_delete_own" on public.recipe_collections
  for delete using (owner_id = (select auth.uid()));

-- ============================================================
-- recipes
-- ============================================================
-- Read via collection (own or public): wrap auth.uid().
drop policy if exists "recipes_read_via_collection" on public.recipes;
create policy "recipes_read_via_collection" on public.recipes
  for select using (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id
        and (c.owner_id = (select auth.uid()) or c.is_public)
    )
  );

-- Household-library read: inline helper, keep short-circuit first.
drop policy if exists "recipes_read_household_library" on public.recipes;
create policy "recipes_read_household_library" on public.recipes
  for select using (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id
        and c.owner_id <> (select auth.uid())
        and exists (
          select 1
          from public.household_members owner_m
          join public.household_members viewer_m
            on viewer_m.household_id = owner_m.household_id
          where owner_m.user_id = c.owner_id
            and owner_m.left_at is null
            and owner_m.library_shared = true
            and viewer_m.user_id = (select auth.uid())
            and viewer_m.left_at is null
        )
    )
  );

-- Admin read: inline is_admin.
drop policy if exists "recipes_admin_read" on public.recipes;
create policy "recipes_admin_read" on public.recipes
  for select using (
    exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- Write via collection: wrap auth.uid().
drop policy if exists "recipes_write_via_collection" on public.recipes;
create policy "recipes_write_via_collection" on public.recipes
  for all
  using (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id and c.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id and c.owner_id = (select auth.uid())
    )
  );

-- ============================================================
-- ingredients
-- ============================================================
drop policy if exists "ingredients_read_via_recipe" on public.ingredients;
create policy "ingredients_read_via_recipe" on public.ingredients
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id
        and (c.owner_id = (select auth.uid()) or c.is_public)
    )
  );

drop policy if exists "ingredients_read_household_library" on public.ingredients;
create policy "ingredients_read_household_library" on public.ingredients
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id
        and c.owner_id <> (select auth.uid())
        and exists (
          select 1
          from public.household_members owner_m
          join public.household_members viewer_m
            on viewer_m.household_id = owner_m.household_id
          where owner_m.user_id = c.owner_id
            and owner_m.left_at is null
            and owner_m.library_shared = true
            and viewer_m.user_id = (select auth.uid())
            and viewer_m.left_at is null
        )
    )
  );

drop policy if exists "ingredients_write_via_recipe" on public.ingredients;
create policy "ingredients_write_via_recipe" on public.ingredients
  for all
  using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id and c.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id and c.owner_id = (select auth.uid())
    )
  );

-- ============================================================
-- instructions
-- ============================================================
drop policy if exists "instructions_read_via_recipe" on public.instructions;
create policy "instructions_read_via_recipe" on public.instructions
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id
        and (c.owner_id = (select auth.uid()) or c.is_public)
    )
  );

drop policy if exists "instructions_read_household_library" on public.instructions;
create policy "instructions_read_household_library" on public.instructions
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id
        and c.owner_id <> (select auth.uid())
        and exists (
          select 1
          from public.household_members owner_m
          join public.household_members viewer_m
            on viewer_m.household_id = owner_m.household_id
          where owner_m.user_id = c.owner_id
            and owner_m.left_at is null
            and owner_m.library_shared = true
            and viewer_m.user_id = (select auth.uid())
            and viewer_m.left_at is null
        )
    )
  );

drop policy if exists "instructions_write_via_recipe" on public.instructions;
create policy "instructions_write_via_recipe" on public.instructions
  for all
  using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id and c.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id and c.owner_id = (select auth.uid())
    )
  );

-- ============================================================
-- instruction_ingredient_refs
-- ============================================================
drop policy if exists "iir_read_via_instruction" on public.instruction_ingredient_refs;
create policy "iir_read_via_instruction" on public.instruction_ingredient_refs
  for select using (
    exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id
        and (c.owner_id = (select auth.uid()) or c.is_public)
    )
  );

drop policy if exists "iir_read_household_library" on public.instruction_ingredient_refs;
create policy "iir_read_household_library" on public.instruction_ingredient_refs
  for select using (
    exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id
        and c.owner_id <> (select auth.uid())
        and exists (
          select 1
          from public.household_members owner_m
          join public.household_members viewer_m
            on viewer_m.household_id = owner_m.household_id
          where owner_m.user_id = c.owner_id
            and owner_m.left_at is null
            and owner_m.library_shared = true
            and viewer_m.user_id = (select auth.uid())
            and viewer_m.left_at is null
        )
    )
  );

drop policy if exists "iir_write_via_instruction" on public.instruction_ingredient_refs;
create policy "iir_write_via_instruction" on public.instruction_ingredient_refs
  for all
  using (
    exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id
        and c.owner_id = (select auth.uid())
    )
  );

-- ============================================================
-- households
-- ============================================================
-- Read member: was `is_household_member(id, auth.uid()) OR is_admin(...)`.
-- Inlined. The membership check reads only the CALLER's own row
-- (user_id = caller), which household_members' own policy permits via its
-- `user_id = auth.uid()` clause WITHOUT re-entering is_household_member —
-- so this is recursion-safe AND function-free. Equivalence:
-- is_household_member(id, uid) == EXISTS(active row for uid in household id).
drop policy if exists "households_read_member" on public.households;
create policy "households_read_member" on public.households
  for select using (
    exists (
      select 1 from public.household_members m
      where m.household_id = households.id
        and m.user_id = (select auth.uid())
        and m.left_at is null
    )
    or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- Owner update: wrap auth.uid(), inline is_admin.
drop policy if exists "households_owner_update" on public.households;
create policy "households_owner_update" on public.households
  for update using (
    owner_id = (select auth.uid())
    or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- ============================================================
-- household_members  (RETAINS is_household_member / is_admin — inlining
-- this policy recurses on its own table: "infinite recursion detected in
-- policy for relation household_members". This is precisely why
-- is_household_member is SECURITY DEFINER. We only wrap auth.uid().)
-- ============================================================
drop policy if exists "household_members_read_same_household" on public.household_members;
create policy "household_members_read_same_household" on public.household_members
  for select using (
    user_id = (select auth.uid())
    or public.is_household_member(household_id, (select auth.uid()))
    or public.is_admin((select auth.uid()))
  );

-- ============================================================
-- household_invites
-- ============================================================
-- Was `is_household_member(household_id, auth.uid()) OR is_admin(...)`.
-- Inline the membership check as caller-own-row EXISTS (function-free,
-- recursion-safe) and inline is_admin.
drop policy if exists "invites_read_household_members" on public.household_invites;
create policy "invites_read_household_members" on public.household_invites
  for select using (
    exists (
      select 1 from public.household_members m
      where m.household_id = household_invites.household_id
        and m.user_id = (select auth.uid())
        and m.left_at is null
    )
    or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- ============================================================
-- household_join_cooldowns
-- ============================================================
drop policy if exists "cooldowns_self_read" on public.household_join_cooldowns;
create policy "cooldowns_self_read" on public.household_join_cooldowns
  for select using (
    user_id = (select auth.uid())
    or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- ============================================================
-- audit_log
-- ============================================================
-- Was `actor_id = auth.uid()
--       OR (household_id IS NOT NULL AND is_household_member(household_id, auth.uid()))
--       OR is_admin(auth.uid())`.
-- Inline the household check as caller-own-row EXISTS (function-free) and
-- inline is_admin. Equivalence preserved including the NOT NULL guard.
drop policy if exists "audit_self_read" on public.audit_log;
create policy "audit_self_read" on public.audit_log
  for select using (
    actor_id = (select auth.uid())
    or (
      household_id is not null
      and exists (
        select 1 from public.household_members m
        where m.household_id = audit_log.household_id
          and m.user_id = (select auth.uid())
          and m.left_at is null
      )
    )
    or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- ============================================================
-- admins  (RETAINS is_admin — inlining recurses on its own table:
-- "infinite recursion detected in policy for relation admins". Only wrap
-- auth.uid(). The self-read clause `user_id = auth.uid()` already lets a
-- caller see their own row; the is_admin OR clause lets admins see all
-- rows. Both preserved.)
-- ============================================================
drop policy if exists "admins_self_or_admin_read" on public.admins;
create policy "admins_self_or_admin_read" on public.admins
  for select using (
    user_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );
drop policy if exists "admins_only_admin_write" on public.admins;
create policy "admins_only_admin_write" on public.admins
  for insert with check (public.is_admin((select auth.uid())));
drop policy if exists "admins_only_admin_delete" on public.admins;
create policy "admins_only_admin_delete" on public.admins
  for delete using (public.is_admin((select auth.uid())));

-- ============================================================
-- profiles
-- ============================================================
drop policy if exists "profiles_self_read" on public.profiles;
create policy "profiles_self_read" on public.profiles
  for select using ((select auth.uid()) = id);
drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
  for update using ((select auth.uid()) = id);
drop policy if exists "profiles_self_upsert" on public.profiles;
create policy "profiles_self_upsert" on public.profiles
  for insert with check ((select auth.uid()) = id);
-- profiles_admin_update: was is_admin(auth.uid()) -> inline.
drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update" on public.profiles
  for update using (
    exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );
-- profiles_public_read is `using (true)` — left untouched (no function, no auth.uid()).

-- ============================================================
-- reports
-- ============================================================
drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own" on public.reports
  for insert with check (reporter_id = (select auth.uid()));
drop policy if exists "reports_read_own_or_admin" on public.reports;
create policy "reports_read_own_or_admin" on public.reports
  for select using (
    reporter_id = (select auth.uid())
    or exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );
drop policy if exists "reports_update_admin" on public.reports;
create policy "reports_update_admin" on public.reports
  for update using (
    exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- ============================================================
-- moderation_actions
-- ============================================================
drop policy if exists "mod_actions_read_admin" on public.moderation_actions;
create policy "mod_actions_read_admin" on public.moderation_actions
  for select using (
    exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );
drop policy if exists "mod_actions_insert_admin" on public.moderation_actions;
create policy "mod_actions_insert_admin" on public.moderation_actions
  for insert with check (
    exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
    and admin_id = (select auth.uid())
  );

-- ============================================================
-- global_cookbooks / global_toc_entries  (admin write via is_admin)
-- ============================================================
drop policy if exists "global_cookbooks_admin_write" on public.global_cookbooks;
create policy "global_cookbooks_admin_write" on public.global_cookbooks
  for all
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));
drop policy if exists "global_toc_entries_admin_write" on public.global_toc_entries;
create policy "global_toc_entries_admin_write" on public.global_toc_entries
  for all
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));
-- *_read_all on these are `using (true)` — untouched.

-- ============================================================
-- ingredient_nutrition_mappings
-- ============================================================
drop policy if exists "nutrition_mappings_self_or_platform_read" on public.ingredient_nutrition_mappings;
create policy "nutrition_mappings_self_or_platform_read" on public.ingredient_nutrition_mappings
  for select using (owner_id = (select auth.uid()) or owner_id is null);
drop policy if exists "nutrition_mappings_self_write" on public.ingredient_nutrition_mappings;
create policy "nutrition_mappings_self_write" on public.ingredient_nutrition_mappings
  for insert with check (owner_id = (select auth.uid()));
drop policy if exists "nutrition_mappings_self_update" on public.ingredient_nutrition_mappings;
create policy "nutrition_mappings_self_update" on public.ingredient_nutrition_mappings
  for update using (owner_id = (select auth.uid()));
drop policy if exists "nutrition_mappings_self_delete" on public.ingredient_nutrition_mappings;
create policy "nutrition_mappings_self_delete" on public.ingredient_nutrition_mappings
  for delete using (owner_id = (select auth.uid()));
drop policy if exists "nutrition_mappings_admin_platform_write" on public.ingredient_nutrition_mappings;
create policy "nutrition_mappings_admin_platform_write" on public.ingredient_nutrition_mappings
  for all
  using (
    owner_id is null
    and exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  )
  with check (
    owner_id is null
    and exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
  );

-- ============================================================
-- conversion_rules
-- ============================================================
drop policy if exists "conv_own_all" on public.conversion_rules;
create policy "conv_own_all" on public.conversion_rules
  for all
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- ============================================================
-- cli_tokens
-- ============================================================
drop policy if exists "cli_tokens_read_own" on public.cli_tokens;
create policy "cli_tokens_read_own" on public.cli_tokens
  for select using (owner_id = (select auth.uid()));
drop policy if exists "cli_tokens_delete_own" on public.cli_tokens;
create policy "cli_tokens_delete_own" on public.cli_tokens
  for delete using (owner_id = (select auth.uid()));

-- ============================================================
-- import_* tables (owner-scoped)
-- ============================================================
drop policy if exists "import_batches_own_all" on public.import_batches;
create policy "import_batches_own_all" on public.import_batches
  for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists "import_items_own_all" on public.import_items;
create policy "import_items_own_all" on public.import_items
  for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists "import_item_attempts_own_all" on public.import_item_attempts;
create policy "import_item_attempts_own_all" on public.import_item_attempts
  for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists "import_toc_entries_own_all" on public.import_toc_entries;
create policy "import_toc_entries_own_all" on public.import_toc_entries
  for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists "import_batch_variants_read_own" on public.import_batch_variants;
create policy "import_batch_variants_read_own" on public.import_batch_variants
  for select using ((select auth.uid()) = owner_id);
drop policy if exists "import_item_variant_results_read_own" on public.import_item_variant_results;
create policy "import_item_variant_results_read_own" on public.import_item_variant_results
  for select using ((select auth.uid()) = owner_id);

-- ============================================================
-- bakeoff_* tables (owner-scoped)
-- ============================================================
drop policy if exists "bakeoff_runs_read_own" on public.bakeoff_runs;
create policy "bakeoff_runs_read_own" on public.bakeoff_runs
  for select using ((select auth.uid()) = owner_id);
drop policy if exists "bakeoff_runs_insert_own" on public.bakeoff_runs;
create policy "bakeoff_runs_insert_own" on public.bakeoff_runs
  for insert with check ((select auth.uid()) = owner_id);
drop policy if exists "bakeoff_runs_delete_own" on public.bakeoff_runs;
create policy "bakeoff_runs_delete_own" on public.bakeoff_runs
  for delete using ((select auth.uid()) = owner_id);
drop policy if exists "bakeoff_variants_read_own" on public.bakeoff_variants;
create policy "bakeoff_variants_read_own" on public.bakeoff_variants
  for select using ((select auth.uid()) = owner_id);

-- ============================================================
-- rewrite_jobs + user pref tables (owner-scoped)
-- ============================================================
drop policy if exists "rewrite_jobs_own_all" on public.rewrite_jobs;
create policy "rewrite_jobs_own_all" on public.rewrite_jobs
  for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists "shopping_list_items_read_own" on public.shopping_list_items;
create policy "shopping_list_items_read_own" on public.shopping_list_items
  for select using (owner_id = (select auth.uid()));
drop policy if exists "shopping_list_items_write_own" on public.shopping_list_items;
create policy "shopping_list_items_write_own" on public.shopping_list_items
  for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists "user_ocr_keys_own_read" on public.user_ocr_keys;
create policy "user_ocr_keys_own_read" on public.user_ocr_keys
  for select using (owner_id = (select auth.uid()));

drop policy if exists "user_ocr_prefs_read_own" on public.user_ocr_prefs;
create policy "user_ocr_prefs_read_own" on public.user_ocr_prefs
  for select using ((select auth.uid()) = owner_id);
drop policy if exists "user_ocr_prefs_update_own" on public.user_ocr_prefs;
create policy "user_ocr_prefs_update_own" on public.user_ocr_prefs
  for update using ((select auth.uid()) = owner_id);
drop policy if exists "user_ocr_prefs_upsert_own" on public.user_ocr_prefs;
create policy "user_ocr_prefs_upsert_own" on public.user_ocr_prefs
  for insert with check ((select auth.uid()) = owner_id);

drop policy if exists "user_rewrite_prefs_read_own" on public.user_rewrite_prefs;
create policy "user_rewrite_prefs_read_own" on public.user_rewrite_prefs
  for select using ((select auth.uid()) = owner_id);
drop policy if exists "user_rewrite_prefs_update_own" on public.user_rewrite_prefs;
create policy "user_rewrite_prefs_update_own" on public.user_rewrite_prefs
  for update using ((select auth.uid()) = owner_id);
drop policy if exists "user_rewrite_prefs_upsert_own" on public.user_rewrite_prefs;
create policy "user_rewrite_prefs_upsert_own" on public.user_rewrite_prefs
  for insert with check ((select auth.uid()) = owner_id);

-- ============================================================
-- Untouched policies (already optimal: `using (true)` constants, no
-- auth.uid(), no function call): global_conversions_read,
-- global_cookbooks_read_all, global_toc_entries_read_all,
-- nutrition_facts_read_all, nutrition_foods_master_read,
-- nutrition_foods_master_anon_read, ocr_test_fixtures_authenticated_read,
-- rewrite_test_fixtures_authenticated_read, profiles_public_read.
-- ============================================================
