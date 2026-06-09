-- fork_collection: pre-mint child ids instead of re-joining inserted rows.
--
-- BUG (prior version, 20260606000300): after copying recipes / ingredients /
-- instructions into the new collection, it rebuilt the old_id -> new_id maps by
-- re-joining the freshly-INSERTed rows back to the source rows on *natural*
-- keys:
--   recipes      ON (sort_order, title)
--   ingredients  ON (recipe_id, sort_order, name)
--   instructions ON (recipe_id, step_number)
-- recipes.sort_order defaults to 0, so a collection with two recipes that share
-- a title (and the default sort_order) produces a 2x2 cross product in the
-- recipe map. That multiplies the ingredient/instruction inserts and cross-wires
-- instruction_ingredient_refs across recipes — the forked copy ends up with
-- duplicated rows and refs pointing at the wrong recipe's ingredients.
--
-- FIX: mint the new UUIDs up front in `on commit drop` temp tables keyed by the
-- OLD id (a true 1:1 map, immune to natural-key collisions), INSERT every child
-- with its pre-minted explicit id, and map instruction_ingredient_refs through
-- the two id maps. No re-join of inserted rows anywhere.
--
-- Unchanged behavior, preserved verbatim from 20260606000300:
--   * auth check ('Authentication required') and the personal-copy ToS note
--   * source lookup requires is_public = true ('Collection not found or not public')
--   * grant execute to authenticated
--   * the recipes copy still copies only a SUBSET of columns
--     (title, servings_amount, servings_description, sort_order). Newer recipe
--     columns (description, notes, time_estimate, equipment, book_title,
--     page_numbers, source_image_text, servings_amount_max, starred, source_url,
--     cover_image_path, parent_recipe_id) are deliberately NOT copied — that is
--     a pre-existing quirk; this migration intentionally does not change it.
--
-- New: a 60s local statement_timeout. Large public collections fire ~5 per-row
-- triggers per child insert; the fork can run past the authenticated role's 8s
-- ceiling, so give it headroom (mirrors refresh_household_denorm's bump).

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

  -- Large public collections fire ~5 per-row triggers per child insert; give
  -- the fork headroom past the authenticated role's 8s ceiling.
  set local statement_timeout = '60s';

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

  drop table if exists _recipe_map;
  drop table if exists _ing_map;
  drop table if exists _step_map;
  create temporary table _recipe_map(old_id uuid primary key, new_id uuid) on commit drop;
  create temporary table _ing_map   (old_id uuid primary key, new_id uuid) on commit drop;
  create temporary table _step_map  (old_id uuid primary key, new_id uuid) on commit drop;

  -- Pre-mint 1:1 id maps keyed by the OLD id (collision-proof).
  insert into _recipe_map(old_id, new_id)
  select r.id, gen_random_uuid()
  from public.recipes r
  where r.collection_id = src.id;

  insert into _ing_map(old_id, new_id)
  select i.id, gen_random_uuid()
  from public.ingredients i
  join _recipe_map m on m.old_id = i.recipe_id;

  insert into _step_map(old_id, new_id)
  select s.id, gen_random_uuid()
  from public.instructions s
  join _recipe_map m on m.old_id = s.recipe_id;

  -- Copy recipes with explicit pre-minted ids. Column subset matches the prior
  -- version exactly (see header note about the deliberate quirk).
  insert into public.recipes (
    id, collection_id, title, servings_amount, servings_description, sort_order
  )
  select m.new_id, new_collection_id, r.title, r.servings_amount,
         r.servings_description, r.sort_order
  from public.recipes r
  join _recipe_map m on m.old_id = r.id;

  -- Copy ingredients with explicit ids; recipe_id maps through _recipe_map.
  insert into public.ingredients (
    id, recipe_id, sort_order, type, name, preparation, notes,
    quantity_type, quantity_amount, quantity_whole, quantity_numerator,
    quantity_denominator, quantity_min, quantity_max, quantity_unit
  )
  select im.new_id, rm.new_id, i.sort_order, i.type, i.name, i.preparation, i.notes,
         i.quantity_type, i.quantity_amount, i.quantity_whole, i.quantity_numerator,
         i.quantity_denominator, i.quantity_min, i.quantity_max, i.quantity_unit
  from public.ingredients i
  join _recipe_map rm on rm.old_id = i.recipe_id
  join _ing_map im on im.old_id = i.id;

  -- Copy instructions with explicit ids; recipe_id maps through _recipe_map.
  insert into public.instructions (id, recipe_id, step_number, text)
  select sm.new_id, rm.new_id, s.step_number, s.text
  from public.instructions s
  join _recipe_map rm on rm.old_id = s.recipe_id
  join _step_map sm on sm.old_id = s.id;

  -- Re-wire refs through BOTH id maps — no natural-key join, so a ref always
  -- lands on the copied instruction + ingredient of the same recipe.
  insert into public.instruction_ingredient_refs (instruction_id, ingredient_id)
  select sm.new_id, im.new_id
  from public.instruction_ingredient_refs ref
  join _step_map sm on sm.old_id = ref.instruction_id
  join _ing_map im on im.old_id = ref.ingredient_id;

  return new_collection_id;
end;
$$;

grant execute on function public.fork_collection(uuid) to authenticated;
