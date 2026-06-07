-- Household *library* sharing.
--
-- Supersedes the per-collection sharing introduced in
-- 20260606000300_collection_share.sql. Instead of opting in one
-- collection at a time, sharing is now a property of household
-- membership: an active member's *entire* library (every collection
-- they own, plus all recipes/ingredients/instructions inside) is
-- readable by the other active members of the same household.
--
-- Sharing is ON BY DEFAULT for members (`library_shared default true`)
-- — joining a household shares your library with the household. A
-- member can opt out (and back in) via `set_library_sharing`; opting in
-- requires a fresh rights attestation, recorded in audit_log, exactly
-- like the old per-collection attestation. This is the "one-time
-- library attestation" model: one attestation covers the whole library
-- rather than prompting per collection.
--
-- The per-collection `shared_with_household_id` column is left in place
-- (vestigial) so the backfill below can read prior shares and so the
-- local SQLite mirror doesn't need a destructive column drop. It is no
-- longer the sharing mechanism — visibility is membership-driven.

-- ---------- columns ----------

alter table public.household_members
  add column library_shared boolean not null default true,
  add column library_share_attested_at timestamptz,
  add column library_share_attestation text;

-- ---------- visibility helper ----------
--
-- True iff `p_owner` shares their library into a household that the
-- current caller is also an active member of (and the caller isn't the
-- owner — owners read their own rows through the existing owner
-- policies). security definer so it can read household_members without
-- tripping that table's RLS, and stable so the planner can cache it
-- per-statement.
--
-- IMPORTANT: every policy below gates this behind a cheap
-- `owner_id <> auth.uid()` predicate. Supabase Realtime evaluates
-- SELECT policies to decide message delivery, and evaluating a
-- security-definer function for the row owner's *own* changes breaks
-- that delivery. The short-circuit means the function is only reached
-- for *other* members' rows (which propagate via the household poll,
-- not realtime), mirroring how the previous per-collection policy hid
-- its function call behind a column guard.

create or replace function public.viewer_can_read_owner_library(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members owner_m
    join public.household_members viewer_m
      on viewer_m.household_id = owner_m.household_id
    where owner_m.user_id = p_owner
      and owner_m.left_at is null
      and owner_m.library_shared = true
      and viewer_m.user_id = auth.uid()
      and viewer_m.left_at is null
      and p_owner <> auth.uid()
  );
$$;
grant execute on function public.viewer_can_read_owner_library(uuid) to authenticated;

-- ---------- swap per-collection read policies for library-wide ones ----------

drop policy if exists "collections_read_household" on public.recipe_collections;
drop policy if exists "recipes_read_via_household" on public.recipes;
drop policy if exists "ingredients_read_via_household" on public.ingredients;
drop policy if exists "instructions_read_via_household" on public.instructions;
drop policy if exists "iir_read_via_household" on public.instruction_ingredient_refs;

create policy "collections_read_household_library" on public.recipe_collections
  for select using (
    owner_id <> auth.uid()
    and public.viewer_can_read_owner_library(owner_id)
  );

create policy "recipes_read_household_library" on public.recipes
  for select using (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id
        and c.owner_id <> auth.uid()
        and public.viewer_can_read_owner_library(c.owner_id)
    )
  );

create policy "ingredients_read_household_library" on public.ingredients
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id
        and c.owner_id <> auth.uid()
        and public.viewer_can_read_owner_library(c.owner_id)
    )
  );

create policy "instructions_read_household_library" on public.instructions
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id
        and c.owner_id <> auth.uid()
        and public.viewer_can_read_owner_library(c.owner_id)
    )
  );

create policy "iir_read_household_library" on public.instruction_ingredient_refs
  for select using (
    exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id
        and c.owner_id <> auth.uid()
        and public.viewer_can_read_owner_library(c.owner_id)
    )
  );

-- ---------- set_library_sharing ----------
--
-- Toggle the caller's library sharing for a household they belong to.
-- Enabling requires the current ToS and a non-empty rights attestation
-- (the one-time library attestation). Disabling is always allowed.

create or replace function public.set_library_sharing(
  p_household_id uuid,
  p_enabled boolean,
  p_attestation text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.household_members
    where household_id = p_household_id and user_id = v_user and left_at is null
  ) then
    raise exception 'You can only change sharing for a household you are an active member of.'
      using errcode = '42501';
  end if;

  if p_enabled then
    perform public.require_current_tos();
    if p_attestation is null or btrim(p_attestation) = '' then
      raise exception 'An attestation is required to share your library with a household.'
        using errcode = 'P0001';
    end if;

    update public.household_members
      set library_shared = true,
          library_share_attested_at = now(),
          library_share_attestation = btrim(p_attestation)
      where household_id = p_household_id and user_id = v_user and left_at is null;

    perform public.record_audit(
      'LIBRARY_SHARED', 'HOUSEHOLD', p_household_id, p_household_id,
      jsonb_build_object('attestation', btrim(p_attestation))
    );
    perform public.record_audit(
      'ATTESTATION_GIVEN', 'HOUSEHOLD', p_household_id, p_household_id,
      jsonb_build_object('attestation', btrim(p_attestation), 'scope', 'LIBRARY')
    );
  else
    update public.household_members
      set library_shared = false,
          library_share_attested_at = null,
          library_share_attestation = null
      where household_id = p_household_id and user_id = v_user and left_at is null;

    perform public.record_audit(
      'LIBRARY_UNSHARED', 'HOUSEHOLD', p_household_id, p_household_id, '{}'::jsonb
    );
  end if;
end;
$$;
grant execute on function public.set_library_sharing(uuid, boolean, text) to authenticated;

-- ---------- retire the per-collection share RPCs ----------
--
-- Visibility is membership-driven now; these have no callers left.
drop function if exists public.share_collection_with_household(uuid, uuid, text);
drop function if exists public.unshare_collection_from_household(uuid);

-- ---------- re-point the public-flip cascade at library sharing ----------
--
-- The escalation rule is unchanged in spirit: publishing a collection
-- that is currently *household-shared* requires a fresh public-scope
-- attestation (a stronger claim than household-only). Under the library
-- model a collection is household-shared iff its owner currently shares
-- their library, so check that instead of the per-collection column.

-- NB: preserve the 20260606000600 relaxation — `require_current_tos()`
-- stays *inside* the household-shared branch so plain "I just authored
-- this" publishes (and the disabled-account / realtime paths) aren't
-- gated on formal ToS. Only the household → public escalation is.
create or replace function public.enforce_household_public_cascade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_public and not coalesce(old.is_public, false) then
    -- A collection is "household-shared" iff its owner currently shares
    -- their library. Only that escalation needs the formal ToS + fresh
    -- attestation; other public flips fall through to the moderation /
    -- disabled-account / ISBN triggers.
    if exists (
      select 1 from public.household_members
      where user_id = new.owner_id and left_at is null and library_shared = true
    ) then
      perform public.require_current_tos();
      if new.last_share_attested_at is null
         or new.last_share_attested_at < now() - interval '5 minutes' then
        raise exception 'A fresh public attestation is required before publishing a household-shared collection.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ---------- backfill ----------
--
-- Anyone who had previously shared >=1 collection per-collection has
-- already attested; carry that forward so their visibility is preserved
-- (now widened to their whole library, which is the intended migration).
-- Members who never shared keep the default (library_shared = true) but
-- with a null attestation timestamp — the app surfaces a one-time
-- attestation prompt for them.

with prior_shares as (
  select
    c.owner_id,
    hm.household_id,
    max(c.last_share_attested_at) as attested_at,
    (array_agg(c.last_share_attestation order by c.last_share_attested_at desc nulls last))[1]
      as attestation
  from public.recipe_collections c
  join public.household_members hm
    on hm.user_id = c.owner_id
   and hm.household_id = c.shared_with_household_id
   and hm.left_at is null
  where c.shared_with_household_id is not null
  group by c.owner_id, hm.household_id
)
update public.household_members hm
  set library_shared = true,
      library_share_attested_at = coalesce(ps.attested_at, now()),
      library_share_attestation = coalesce(
        ps.attestation,
        'Backfilled from per-collection household share.'
      )
  from prior_shares ps
  where hm.user_id = ps.owner_id
    and hm.household_id = ps.household_id
    and hm.left_at is null;

-- Audit the backfill so the trail is explicit. actor_id is null
-- (system migration); attribution is via target/household + metadata.
insert into public.audit_log (actor_id, action, target_type, target_id, household_id, metadata)
select
  null,
  'LIBRARY_SHARED',
  'HOUSEHOLD',
  hm.household_id,
  hm.household_id,
  jsonb_build_object('backfill', true, 'user_id', hm.user_id)
from public.household_members hm
where hm.left_at is null
  and hm.library_share_attested_at is not null;
