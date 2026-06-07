-- Make recipe_embeddings a first-class household-shared table so semantic
-- search covers co-members' recipes — using the same claim-based template as
-- the other shared tables (20260623000100 denorm + 20260623000200 claim RLS).
--
-- recipe_embeddings is recipe-keyed, so (like ingredients/instructions) it
-- carries denormalized owner_id + household_id stamped off the parent recipe.
-- The read policy then becomes a pure column-vs-claim compare — no
-- recipes/recipe_collections join on the household branch, no
-- household_members lookup, no security-definer call.

-- ============================================================
-- 1. columns (no FK — trigger-maintained, matches the denorm pattern)
-- ============================================================
alter table public.recipe_embeddings add column if not exists owner_id uuid;
alter table public.recipe_embeddings add column if not exists household_id uuid;

-- ============================================================
-- 2. backfill from the parent recipe (which already carries both, per
--    20260623000100). Set-based; the trigger below doesn't exist yet.
-- ============================================================
update public.recipe_embeddings e
   set owner_id = r.owner_id,
       household_id = r.household_id
  from public.recipes r
 where r.id = e.recipe_id
   and (e.owner_id is distinct from r.owner_id
        or e.household_id is distinct from r.household_id);

-- ============================================================
-- 3. write-time stamp: new embeddings (embed_complete / embed_upsert_client
--    insert recipe_id only) get owner_id + household_id off the parent recipe.
--    INSERT-only: the RPCs' ON CONFLICT update leaves owner_id/household_id
--    untouched, and recipe-side changes are cascaded in step 4.
-- ============================================================
create or replace function public.set_embedding_owner_from_recipe()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select owner_id, household_id into new.owner_id, new.household_id
    from public.recipes where id = new.recipe_id;
  return new;
end;
$$;
drop trigger if exists recipe_embeddings_set_owner on public.recipe_embeddings;
create trigger recipe_embeddings_set_owner
  before insert on public.recipe_embeddings
  for each row execute function public.set_embedding_owner_from_recipe();

-- ============================================================
-- 4. cascade recipe-side owner_id / household_id changes onto the embedding.
--    Covers BOTH a collection move (recipes_set_owner re-stamps the recipe)
--    AND a sharing toggle (refresh_household_denorm bulk-updates recipes) —
--    one AFTER trigger instead of editing those functions, so this stays
--    correct across future changes to them.
-- ============================================================
create or replace function public.sync_embedding_household_from_recipe()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.owner_id is distinct from old.owner_id
     or new.household_id is distinct from old.household_id then
    update public.recipe_embeddings
       set owner_id = new.owner_id, household_id = new.household_id
     where recipe_id = new.id;
  end if;
  return null; -- AFTER trigger
end;
$$;
drop trigger if exists recipes_sync_embedding_household on public.recipes;
create trigger recipes_sync_embedding_household
  after update of owner_id, household_id on public.recipes
  for each row execute function public.sync_embedding_household_from_recipe();

-- ============================================================
-- 5. claim-based read policy (mirror ingredients_read from 20260623000200):
--    own (column) OR household (claim) OR public (collection join, last).
--    `own` is OR'd first and the household branch keeps owner_id <> uid as
--    its first AND-term, so the claim compare is skipped for own rows
--    (keeps Realtime delivery working). Writes stay on embed_complete /
--    embed_upsert_client (service_role / SECURITY DEFINER) — no write policy.
-- ============================================================
drop policy if exists "recipe_embeddings_read" on public.recipe_embeddings;
create policy "recipe_embeddings_read" on public.recipe_embeddings
  for select using (
    owner_id = (select auth.uid())
    or (
      owner_id <> (select auth.uid())
      and household_id = (auth.jwt() ->> 'household_id')::uuid
    )
    or exists (
      select 1
        from public.recipes r
        join public.recipe_collections c on c.id = r.collection_id
       where r.id = recipe_embeddings.recipe_id and c.is_public
    )
  );

-- ============================================================
-- 6. index: the household pull filters by household_id (shared rows only).
-- ============================================================
create index if not exists recipe_embeddings_household_idx
  on public.recipe_embeddings(household_id)
  where household_id is not null;

analyze public.recipe_embeddings;
