-- Ingredient → recipe cross-reference links.
--
-- An ingredient whose name IS another recipe in the same collection (a
-- component / sub-recipe — "Almond and Cherry Cream Pie" calls for "Double
-- Almond Crust") gets a stored link. The link is computed client-side by the
-- same-collection matcher (packages/domain/src/services/recipeLinks.ts),
-- applied at recipe save-time and by a re-runnable client backfill, and rides
-- to Postgres on the normal recipe push (save_recipes_graph) like any column.
--
-- link_source records provenance: 'auto' (matcher), 'manual' (user picked, may
-- cross books), 'dismissed' (user unlinked — linked_recipe_id cleared;
-- suppresses re-auto-linking). Both columns nullable: no NOT NULL / default
-- issues, and the on-delete-set-null keeps a link from dangling server-side
-- when its target recipe is hard-deleted.

alter table public.ingredients
  add column if not exists linked_recipe_id uuid references public.recipes(id) on delete set null,
  add column if not exists link_source text;

-- Reverse lookups ("what recipes reference recipe B") and FK maintenance.
create index if not exists ingredients_linked_recipe_idx
  on public.ingredients(linked_recipe_id) where linked_recipe_id is not null;

-- ---------------------------------------------------------------------------
-- save_recipes_graph: preserve links across the wholesale child-replace.
--
-- The RPC replaces a recipe's ingredients with `delete ... ; insert ... from
-- jsonb_populate_recordset(...)`. A writer that omits the link keys (an older
-- app bundle, the re-OCR import path, any non-link-aware client) would
-- therefore NULL linked_recipe_id/link_source — and a wiped 'dismissed'/
-- 'manual' row would then be re-auto-linked, silently destroying user intent.
--
-- Fix (mirrors the has_content strip-preserve trick in 20260630000000): before
-- the delete, snapshot each recipe's existing links keyed by (recipe_id,
-- normalized name). On insert, GRAFT the snapshot onto any ingredient element
-- that OMITS the link keys, while TRUSTING elements that include them (a
-- link-aware client sends both keys via `select *`, including an explicit null
-- for a dismissal — jsonb `?` treats an explicit-null key as present). Net:
-- link-aware writes are authoritative; link-unaware writes can't wipe links.
--
-- Otherwise byte-identical to 20260630000000.
create or replace function public.save_recipes_graph(p_recipes jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_recipes jsonb;
  v_ids uuid[];
  v_old_links jsonb;
begin
  if p_recipes is null or jsonb_typeof(p_recipes) <> 'array' then
    raise exception 'save_recipes_graph: p_recipes must be a jsonb array';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_recipes) item
    where jsonb_typeof(item -> 'recipe') <> 'object' or (item -> 'recipe' ->> 'id') is null
  ) then
    raise exception 'save_recipes_graph: every item needs a recipe object with an id';
  end if;

  select jsonb_agg(item order by ord)
    into v_recipes
  from (
    select distinct on ((item -> 'recipe' ->> 'id')) item, ord
    from jsonb_array_elements(p_recipes) with ordinality as t(item, ord)
    order by (item -> 'recipe' ->> 'id'), ord desc
  ) d;

  if v_recipes is null then
    return;
  end if;

  select array_agg((item -> 'recipe' ->> 'id')::uuid)
    into v_ids
  from jsonb_array_elements(v_recipes) item;

  insert into public.recipes
  select * from jsonb_populate_recordset(
    null::public.recipes,
    (select jsonb_agg(
        ((item -> 'recipe') - 'created_at' - 'updated_at' - 'has_content')
        || jsonb_build_object('created_at', now(), 'updated_at', now(), 'has_content', false))
       from jsonb_array_elements(v_recipes) item))
  on conflict (id) do update set
    collection_id       = excluded.collection_id,
    title               = excluded.title,
    servings_amount     = excluded.servings_amount,
    servings_description = excluded.servings_description,
    sort_order          = excluded.sort_order,
    notes               = excluded.notes,
    parent_recipe_id    = excluded.parent_recipe_id,
    description         = excluded.description,
    time_estimate       = excluded.time_estimate,
    equipment           = excluded.equipment,
    book_title          = excluded.book_title,
    page_numbers        = excluded.page_numbers,
    source_image_text   = excluded.source_image_text,
    servings_amount_max = excluded.servings_amount_max,
    starred             = excluded.starred,
    source_url          = excluded.source_url,
    cover_image_path    = excluded.cover_image_path;

  -- Snapshot existing links (keyed recipe_id|normalized-name) BEFORE the
  -- delete. For a dup-named ingredient prefer the row that carries intent.
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    into v_old_links
  from (
    select (recipe_id::text || '|' || lower(btrim(name))) as k,
           jsonb_build_object(
             'lr', (array_agg(linked_recipe_id order by (link_source is distinct from null) desc))[1],
             'ls', (array_agg(link_source     order by (link_source is distinct from null) desc))[1]
           ) as v
      from public.ingredients
     where recipe_id = any (v_ids)
     group by recipe_id, lower(btrim(name))
  ) s;

  delete from public.ingredients where recipe_id = any (v_ids);
  delete from public.instructions where recipe_id = any (v_ids);

  insert into public.ingredients
  select * from jsonb_populate_recordset(null::public.ingredients,
    (select coalesce(jsonb_agg(
        case
          when ing ? 'link_source' or ing ? 'linked_recipe_id' then ing
          else ing
            || jsonb_build_object('linked_recipe_id',
                 v_old_links -> ((ing ->> 'recipe_id') || '|' || lower(btrim(ing ->> 'name'))) ->> 'lr')
            || jsonb_build_object('link_source',
                 v_old_links -> ((ing ->> 'recipe_id') || '|' || lower(btrim(ing ->> 'name'))) ->> 'ls')
        end), '[]'::jsonb)
       from jsonb_array_elements(v_recipes) item,
            jsonb_array_elements(coalesce(item -> 'ingredients', '[]'::jsonb)) ing));

  insert into public.instructions
  select * from jsonb_populate_recordset(null::public.instructions,
    (select coalesce(jsonb_agg(s), '[]'::jsonb)
       from jsonb_array_elements(v_recipes) item,
            jsonb_array_elements(coalesce(item -> 'instructions', '[]'::jsonb)) s));

  insert into public.instruction_ingredient_refs
  select * from jsonb_populate_recordset(null::public.instruction_ingredient_refs,
    (select coalesce(jsonb_agg(rf), '[]'::jsonb)
       from jsonb_array_elements(v_recipes) item,
            jsonb_array_elements(coalesce(item -> 'refs', '[]'::jsonb)) rf));
end;
$$;
revoke all on function public.save_recipes_graph(jsonb) from public;
grant execute on function public.save_recipes_graph(jsonb) to authenticated;
