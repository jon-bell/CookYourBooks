-- Denormalize owner_id (recipes) + household_id (all 7 shared tables) so the
-- claim-based RLS in 20260623000200 is a pure column-vs-claim compare.
--
-- WHY: `recipes` is the only hot sync table without `owner_id` — ownership
-- routed through a recipe_collections join (client embed + correlated RLS
-- EXISTS, the same data joined up to 3x/row). And the household read branch
-- on every shared table self-joins household_members. Carrying `owner_id` on
-- recipes (like 20260612 did for the children) and a maintained `household_id`
-- on every shared table turns both into column compares:
--   own       : owner_id = (select auth.uid())
--   household  : owner_id <> (select auth.uid()) and household_id = <jwt claim>
--
-- household_id = the owner's *active sharing* household, or NULL when the
-- owner isn't sharing — so sharing is encoded in the column and the policy
-- needs no per-co-member library_shared lookup.
--
-- MAINTENANCE (mirrors owner_id's two-mechanism upkeep from 20260612):
--   * on row write  -> BEFORE triggers stamp it from the owner's membership
--   * on transition -> refresh_household_denorm(owner) bulk-updates the
--     owner's rows (called from the household RPCs, 20260623000110)
-- refresh_household_denorm does NOT bump updated_at: that would make the
-- owner re-pull their whole library on a sharing toggle. Co-members instead
-- reset their household watermark on a household_members change (SyncProvider).
--
-- No FK on the denormalized columns (matches 20260612's owner_id): trigger-
-- maintained, and a household_id left pointing at a deleted household is
-- harmless — no live JWT claim can equal it, so those rows are simply
-- unreadable via the household branch (still readable by their owner).
-- SERVER-ONLY: the browser's explicit-column upserts ignore these columns.

-- ============================================================
-- 0. helper: the owner's active *sharing* household (NULL if none)
-- ============================================================
create or replace function public.owner_shared_household(p_owner uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id
    from public.household_members
   where user_id = p_owner
     and left_at is null
     and library_shared = true
   limit 1;
$$;

-- ============================================================
-- 1. columns
-- ============================================================
alter table public.recipes                     add column if not exists owner_id uuid;

alter table public.recipe_collections           add column if not exists household_id uuid;
alter table public.recipes                       add column if not exists household_id uuid;
alter table public.ingredients                   add column if not exists household_id uuid;
alter table public.instructions                  add column if not exists household_id uuid;
alter table public.instruction_ingredient_refs   add column if not exists household_id uuid;
alter table public.cooking_events                add column if not exists household_id uuid;
alter table public.recipe_tags                   add column if not exists household_id uuid;

-- ============================================================
-- 2. backfill (set-based; triggers don't exist yet so they don't fire)
-- ============================================================
-- recipes.owner_id from the collection
update public.recipes r
   set owner_id = c.owner_id
  from public.recipe_collections c
 where c.id = r.collection_id
   and r.owner_id is distinct from c.owner_id;

-- household_id = owner's active sharing household (rows whose owner isn't
-- sharing stay NULL). One join per table — no per-row function call.
update public.recipe_collections t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;
update public.recipes t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;
update public.ingredients t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;
update public.instructions t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;
update public.instruction_ingredient_refs t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;
update public.cooking_events t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;
update public.recipe_tags t
   set household_id = hm.household_id
  from public.household_members hm
 where hm.user_id = t.owner_id and hm.left_at is null and hm.library_shared = true;

-- ============================================================
-- 3. write-time triggers
-- ============================================================
-- recipes: owner_id + household_id from the collection / owner.
create or replace function public.set_recipe_owner_from_collection()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Mirror the collection's owner + its denormalized household_id (the
  -- collection is the single source of truth, kept current by
  -- set_owned_row_household / refresh_household_denorm) — so no
  -- household_members lookup per recipe write.
  select owner_id, household_id into new.owner_id, new.household_id
    from public.recipe_collections where id = new.collection_id;
  return new;
end;
$$;
drop trigger if exists recipes_set_owner on public.recipes;
create trigger recipes_set_owner
  before insert or update of collection_id on public.recipes
  for each row execute function public.set_recipe_owner_from_collection();

-- children keyed off recipe_id (ingredients, instructions) — extend the
-- 20260612 owner trigger function to also stamp household_id.
create or replace function public.set_child_owner_from_recipe()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- recipes now carries owner_id + household_id, so read them straight off
  -- the parent (one PK lookup — no recipe_collections join, no
  -- household_members lookup) on every child write.
  select owner_id, household_id into new.owner_id, new.household_id
    from public.recipes where id = new.recipe_id;
  return new;
end;
$$;

-- refs keyed off instruction_id.
create or replace function public.set_ref_owner_from_instruction()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- instructions carries owner_id + household_id; read them off the parent
  -- instruction (one PK lookup, no multi-table join) on every ref write.
  select owner_id, household_id into new.owner_id, new.household_id
    from public.instructions where id = new.instruction_id;
  return new;
end;
$$;

-- recipe collection move: cascade owner_id + household_id to children.
create or replace function public.sync_children_owner_on_recipe_move()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- recipes_set_owner (BEFORE UPDATE OF collection_id) already re-stamped the
  -- recipe's own owner_id + household_id, so cascade those exact values to the
  -- children — no extra collection / household_members lookups.
  if new.collection_id is distinct from old.collection_id then
    update public.ingredients  set owner_id = new.owner_id, household_id = new.household_id where recipe_id = new.id;
    update public.instructions set owner_id = new.owner_id, household_id = new.household_id where recipe_id = new.id;
    update public.instruction_ingredient_refs ref
       set owner_id = new.owner_id, household_id = new.household_id
      from public.instructions ins
     where ins.id = ref.instruction_id and ins.recipe_id = new.id;
  end if;
  return new;
end;
$$;

-- owner-keyed tables (collection / cooking_events / recipe_tags): the client
-- sets owner_id directly, so a small trigger stamps household_id from it.
-- Fires only when owner_id is (re)written, not on ordinary edits — so
-- refresh_household_denorm's household_id-only updates don't refire it.
create or replace function public.set_owned_row_household()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.household_id := public.owner_shared_household(new.owner_id);
  return new;
end;
$$;
drop trigger if exists recipe_collections_set_household on public.recipe_collections;
create trigger recipe_collections_set_household
  before insert or update of owner_id on public.recipe_collections
  for each row execute function public.set_owned_row_household();
drop trigger if exists cooking_events_set_household on public.cooking_events;
create trigger cooking_events_set_household
  before insert or update of owner_id on public.cooking_events
  for each row execute function public.set_owned_row_household();
drop trigger if exists recipe_tags_set_household on public.recipe_tags;
create trigger recipe_tags_set_household
  before insert or update of owner_id on public.recipe_tags
  for each row execute function public.set_owned_row_household();

-- ============================================================
-- 4. transition bulk-update (called from the household RPCs)
-- ============================================================
create or replace function public.refresh_household_denorm(p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_hh uuid;
begin
  -- A large library is the one heavy write in this whole design, and it's
  -- rare (7-day join cooldown). Lift the authenticated 8s timeout for it.
  set local statement_timeout = '120s';
  v_hh := public.owner_shared_household(p_owner);
  update public.recipe_collections          set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipes                      set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.ingredients                  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.instructions                 set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.instruction_ingredient_refs  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.cooking_events               set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
  update public.recipe_tags                  set household_id = v_hh where owner_id = p_owner and household_id is distinct from v_hh;
end;
$$;
revoke all on function public.refresh_household_denorm(uuid) from public, anon, authenticated;

-- Drive the bulk refresh off household_members changes rather than editing
-- each household RPC — this covers every transition path uniformly and stays
-- correct for any future RPC: create/accept INSERT an active row; leave/remove
-- set left_at; set_library_sharing toggles library_shared. (DELETE isn't
-- handled: a household teardown cascade-deletes memberships, leaving a dangling
-- household_id that no live claim can match — harmless, and cleared on the
-- owner's next write.)
create or replace function public.household_members_refresh_denorm()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_household_denorm(new.user_id);
  return null; -- AFTER trigger
end;
$$;
drop trigger if exists household_members_denorm on public.household_members;
create trigger household_members_denorm
  after insert or update of left_at, library_shared on public.household_members
  for each row execute function public.household_members_refresh_denorm();

-- ============================================================
-- 5. indexes
-- ============================================================
-- recipes pull shapes: owned incremental (owner_id, updated_at) + full-pull
-- keyset (owner_id, id). recipes_updated_at_idx stays for the household neq path.
create index if not exists recipes_owner_updated_idx on public.recipes(owner_id, updated_at);
create index if not exists recipes_owner_id_idx      on public.recipes(owner_id, id);

-- household pull filters by household_id; partial (shared rows only).
create index if not exists recipe_collections_household_denorm_idx        on public.recipe_collections(household_id)        where household_id is not null;
create index if not exists recipes_household_idx                          on public.recipes(household_id)                   where household_id is not null;
create index if not exists ingredients_household_idx                      on public.ingredients(household_id)               where household_id is not null;
create index if not exists instructions_household_idx                     on public.instructions(household_id)              where household_id is not null;
create index if not exists instruction_ingredient_refs_household_idx      on public.instruction_ingredient_refs(household_id) where household_id is not null;
create index if not exists cooking_events_household_idx                   on public.cooking_events(household_id)            where household_id is not null;
create index if not exists recipe_tags_household_idx                      on public.recipe_tags(household_id)               where household_id is not null;

analyze public.recipes;
analyze public.recipe_collections;
analyze public.ingredients;
analyze public.instructions;
analyze public.instruction_ingredient_refs;
analyze public.cooking_events;
analyze public.recipe_tags;
