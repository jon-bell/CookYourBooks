-- Household collection sharing.
--
-- A collection can be shared with at most one household at a time
-- (`shared_with_household_id`). Members of that household get read
-- access to the collection and its recipes / ingredients / instructions
-- via RLS, but cannot edit, fork-to-public, or re-share onward.
--
-- Sharing requires the owner to attest in writing that they own the
-- content or have the right to share it. The attestation text and
-- timestamp are recorded in audit_log; `last_share_attested_at` on the
-- collection is the fast path for the public-flip cascade trigger.
--
-- ISBN-tagged cookbooks: explicitly allowed to be household-shared.
-- The existing `enforce_no_public_isbn_cookbook` trigger only fires on
-- `is_public`, so household-sharing an ISBN cookbook is a legal path.
-- This mirrors the spouse-Xerox case copyright law is most lenient
-- about — a family that owns the cookbook digitally accessing it on
-- each other's devices.

alter table public.recipe_collections
  add column shared_with_household_id uuid references public.households(id) on delete set null,
  add column last_share_attested_at timestamptz,
  add column last_share_attestation text;

create index recipe_collections_household_idx
  on public.recipe_collections(shared_with_household_id)
  where shared_with_household_id is not null;

-- ---------- RLS extensions ----------
--
-- The existing `collections_read_own_or_public` policy covers the
-- owner and public. Add a household-read policy alongside it.

create policy "collections_read_household" on public.recipe_collections
  for select using (
    shared_with_household_id is not null
    and public.is_household_member(shared_with_household_id, auth.uid())
  );

-- Recipes / ingredients / instructions inherit from the parent via the
-- existing "_read_via_collection" / "_read_via_recipe" policies, but
-- those check (owner_id = auth.uid() or is_public). Add parallel
-- household-read policies so the cascade visibility actually works.

create policy "recipes_read_via_household" on public.recipes
  for select using (
    exists (
      select 1 from public.recipe_collections c
      where c.id = recipes.collection_id
        and c.shared_with_household_id is not null
        and public.is_household_member(c.shared_with_household_id, auth.uid())
    )
  );

create policy "ingredients_read_via_household" on public.ingredients
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = ingredients.recipe_id
        and c.shared_with_household_id is not null
        and public.is_household_member(c.shared_with_household_id, auth.uid())
    )
  );

create policy "instructions_read_via_household" on public.instructions
  for select using (
    exists (
      select 1 from public.recipes r
      join public.recipe_collections c on c.id = r.collection_id
      where r.id = instructions.recipe_id
        and c.shared_with_household_id is not null
        and public.is_household_member(c.shared_with_household_id, auth.uid())
    )
  );

create policy "iir_read_via_household" on public.instruction_ingredient_refs
  for select using (
    exists (
      select 1 from public.instructions i
      join public.recipes r on r.id = i.recipe_id
      join public.recipe_collections c on c.id = r.collection_id
      where i.id = instruction_ingredient_refs.instruction_id
        and c.shared_with_household_id is not null
        and public.is_household_member(c.shared_with_household_id, auth.uid())
    )
  );

-- ---------- share_collection_with_household ----------

create or replace function public.share_collection_with_household(
  p_collection_id uuid,
  p_household_id uuid,
  p_attestation text
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
  perform public.require_current_tos();

  if p_attestation is null or btrim(p_attestation) = '' then
    raise exception 'An attestation is required to share content with a household.'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.recipe_collections
    where id = p_collection_id and owner_id = v_user
  ) then
    raise exception 'You can only share collections you own.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.household_members
    where household_id = p_household_id and user_id = v_user and left_at is null
  ) then
    raise exception 'You can only share with a household you are an active member of.'
      using errcode = '42501';
  end if;

  update public.recipe_collections
    set shared_with_household_id = p_household_id,
        last_share_attested_at = now(),
        last_share_attestation = btrim(p_attestation)
    where id = p_collection_id;

  perform public.record_audit(
    'COLLECTION_SHARED', 'COLLECTION', p_collection_id, p_household_id,
    jsonb_build_object('attestation', btrim(p_attestation))
  );
  perform public.record_audit(
    'ATTESTATION_GIVEN', 'COLLECTION', p_collection_id, p_household_id,
    jsonb_build_object('attestation', btrim(p_attestation), 'scope', 'HOUSEHOLD')
  );
end;
$$;
grant execute on function public.share_collection_with_household(uuid, uuid, text) to authenticated;

-- ---------- unshare_collection_from_household ----------

create or replace function public.unshare_collection_from_household(p_collection_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_household_id uuid;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select shared_with_household_id into v_household_id
  from public.recipe_collections
  where id = p_collection_id and owner_id = v_user;
  if not found then
    raise exception 'Collection not found or not yours.' using errcode = '42501';
  end if;
  if v_household_id is null then
    return; -- already not shared, idempotent
  end if;

  update public.recipe_collections
    set shared_with_household_id = null,
        last_share_attested_at = null,
        last_share_attestation = null
    where id = p_collection_id;

  perform public.record_audit(
    'COLLECTION_UNSHARED', 'COLLECTION', p_collection_id, v_household_id, '{}'::jsonb
  );
end;
$$;
grant execute on function public.unshare_collection_from_household(uuid) to authenticated;

-- ---------- public-flip cascade trigger ----------
--
-- If a collection is currently shared with a household and the owner
-- flips is_public=true, that materially changes the attestation
-- (household-only "I have rights to share with my household" is a
-- *weaker* claim than public "I have rights to share with the
-- world"). Require a fresh public attestation in the same transaction
-- — the share RPC bumped last_share_attested_at, the public-flip dialog
-- needs to call `attest_public_share` first.

create or replace function public.enforce_household_public_cascade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_public and not coalesce(old.is_public, false) then
    -- ToS gate.
    perform public.require_current_tos();
    -- If the collection is currently household-shared, require the
    -- public attestation to have been given within the last 5 minutes
    -- (proven by `last_share_attested_at` being moved forward by
    -- `attest_public_share` immediately before the flip).
    if new.shared_with_household_id is not null then
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

create trigger enforce_household_public_cascade_trg
  before insert or update of is_public on public.recipe_collections
  for each row execute function public.enforce_household_public_cascade();

-- ---------- attest_public_share ----------
--
-- Step 1 of the make-public dialog when a household-shared collection
-- is being escalated to public. Writes the attestation row and bumps
-- last_share_attested_at so the cascade trigger above lets the flip
-- through. Client follows up with a normal UPDATE setting is_public.

create or replace function public.attest_public_share(
  p_collection_id uuid,
  p_attestation text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_household_id uuid;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_attestation is null or btrim(p_attestation) = '' then
    raise exception 'Attestation text is required.' using errcode = 'P0001';
  end if;

  select shared_with_household_id into v_household_id
  from public.recipe_collections
  where id = p_collection_id and owner_id = v_user;
  if not found then
    raise exception 'Collection not found or not yours.' using errcode = '42501';
  end if;

  update public.recipe_collections
    set last_share_attested_at = now(),
        last_share_attestation = btrim(p_attestation)
    where id = p_collection_id;

  perform public.record_audit(
    'ATTESTATION_GIVEN', 'COLLECTION', p_collection_id, v_household_id,
    jsonb_build_object('attestation', btrim(p_attestation), 'scope', 'PUBLIC')
  );
end;
$$;
grant execute on function public.attest_public_share(uuid, text) to authenticated;

-- ---------- audit COLLECTION_MADE_PUBLIC on the flip ----------

create or replace function public.audit_collection_public_flip()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_public and not coalesce(old.is_public, false) then
    perform public.record_audit(
      'COLLECTION_MADE_PUBLIC', 'COLLECTION', new.id, new.shared_with_household_id,
      jsonb_build_object('was_household_shared', new.shared_with_household_id is not null)
    );
  elsif coalesce(old.is_public, false) and not new.is_public then
    perform public.record_audit(
      'COLLECTION_UNPUBLISHED', 'COLLECTION', new.id, new.shared_with_household_id, '{}'::jsonb
    );
  end if;
  return null; -- AFTER trigger, return value ignored
end;
$$;

create trigger audit_collection_public_flip_trg
  after update of is_public on public.recipe_collections
  for each row execute function public.audit_collection_public_flip();

-- ---------- prevent forking a household-shared collection ----------
--
-- Forking is the public-share fork mechanism. A household-shared
-- collection isn't public, so it doesn't appear in fork_collection's
-- search anyway — but we add a defensive check to be explicit. (Users
-- can still copy recipes by hand within the household; that's fine.)

create or replace function public.fork_collection(source_collection_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_collection_id uuid;
  src public.recipe_collections%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  -- Forking is a personal-copy action, not a share / publish action.
  -- The user is producing a private copy for themselves; the ToS gate
  -- applies later when they decide to re-publish or household-share
  -- the fork.

  select * into src from public.recipe_collections
  where id = source_collection_id and is_public = true;
  if not found then
    raise exception 'Collection not found or not public';
  end if;

  insert into public.recipe_collections (
    owner_id, title, source_type, author, isbn, publisher, publication_year,
    description, notes, source_url, date_accessed, site_name,
    is_public, forked_from
  )
  values (
    auth.uid(), src.title, src.source_type, src.author, src.isbn, src.publisher,
    src.publication_year, src.description, src.notes, src.source_url,
    src.date_accessed, src.site_name, false, src.id
  )
  returning id into new_collection_id;

  create temporary table _recipe_map(old_id uuid, new_id uuid) on commit drop;
  create temporary table _ing_map(old_id uuid, new_id uuid) on commit drop;
  create temporary table _step_map(old_id uuid, new_id uuid) on commit drop;

  with inserted as (
    insert into public.recipes (collection_id, title, servings_amount, servings_description, sort_order)
    select new_collection_id, r.title, r.servings_amount, r.servings_description, r.sort_order
    from public.recipes r where r.collection_id = src.id
    returning id, sort_order, title
  ),
  old_ordered as (
    select id, sort_order, title from public.recipes where collection_id = src.id
  )
  insert into _recipe_map(old_id, new_id)
  select o.id, i.id
  from old_ordered o
  join inserted i on i.sort_order = o.sort_order and i.title = o.title;

  with inserted as (
    insert into public.ingredients (
      recipe_id, sort_order, type, name, preparation, notes,
      quantity_type, quantity_amount, quantity_whole, quantity_numerator,
      quantity_denominator, quantity_min, quantity_max, quantity_unit
    )
    select m.new_id, i.sort_order, i.type, i.name, i.preparation, i.notes,
           i.quantity_type, i.quantity_amount, i.quantity_whole, i.quantity_numerator,
           i.quantity_denominator, i.quantity_min, i.quantity_max, i.quantity_unit
    from public.ingredients i
    join _recipe_map m on m.old_id = i.recipe_id
    returning id, recipe_id, sort_order, name
  ),
  old_ordered as (
    select i.id, m.new_id as new_recipe_id, i.sort_order, i.name
    from public.ingredients i join _recipe_map m on m.old_id = i.recipe_id
  )
  insert into _ing_map(old_id, new_id)
  select o.id, ins.id
  from old_ordered o
  join inserted ins
    on ins.recipe_id = o.new_recipe_id
   and ins.sort_order = o.sort_order
   and ins.name = o.name;

  with inserted as (
    insert into public.instructions (recipe_id, step_number, text)
    select m.new_id, s.step_number, s.text
    from public.instructions s
    join _recipe_map m on m.old_id = s.recipe_id
    returning id, recipe_id, step_number
  ),
  old_ordered as (
    select s.id, m.new_id as new_recipe_id, s.step_number
    from public.instructions s join _recipe_map m on m.old_id = s.recipe_id
  )
  insert into _step_map(old_id, new_id)
  select o.id, ins.id
  from old_ordered o
  join inserted ins
    on ins.recipe_id = o.new_recipe_id
   and ins.step_number = o.step_number;

  insert into public.instruction_ingredient_refs (instruction_id, ingredient_id)
  select sm.new_id, im.new_id
  from public.instruction_ingredient_refs ref
  join _step_map sm on sm.old_id = ref.instruction_id
  join _ing_map im on im.old_id = ref.ingredient_id;

  return new_collection_id;
end;
$$;
