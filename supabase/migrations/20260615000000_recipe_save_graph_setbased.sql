-- save_recipes_graph: make it set-based (kill the per-recipe catalog scan).
--
-- WHY: the original (20260614000000) looped over each recipe and, per
-- iteration, queried information_schema.columns to build the conflict-update
-- SET clause + ran a per-row dynamic EXECUTE. On prod's bloated catalog one
-- information_schema.columns scan measured ~245ms (174ms planning + 72ms
-- exec). A 25-recipe push chunk therefore spent ~6s *just on catalog scans*,
-- which under any contention on the 512MB / fractional-CPU box tipped past
-- the `authenticated` role's 8s statement_timeout (57014) — exactly the
-- timeout seen while importing a Table of Contents (which enqueues many
-- recipe_save rows that the outbox flushes in 25-row chunks).
--
-- This rewrite does the whole batch in a fixed handful of set-based
-- statements: one multi-row recipe upsert (static column list, matching the
-- client's upsertRecipeRow) + one delete + one insert per child table. No
-- loop, no information_schema, no dynamic SQL. Cost is independent of catalog
-- bloat and roughly independent of batch size.
--
-- Still SECURITY INVOKER (RLS gates every statement) and the child-owner
-- BEFORE INSERT triggers still stamp owner_id. created_at/updated_at are
-- forced to now() on the insert (there is no BEFORE INSERT trigger and an
-- explicit NULL would violate NOT NULL); on conflict created_at is left
-- untouched and touch_updated_at owns updated_at.

create or replace function public.save_recipes_graph(p_recipes jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_recipes jsonb;   -- deduped: one item per recipe id (last wins)
  v_ids uuid[];
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

  -- Dedupe items by recipe id (an outbox run can carry the same recipe
  -- twice) keeping the last occurrence, so the single set-based upsert
  -- below can't trip "ON CONFLICT DO UPDATE cannot affect row a second time".
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

  -- 1) Upsert every recipe in one statement.
  insert into public.recipes
  select * from jsonb_populate_recordset(
    null::public.recipes,
    (select jsonb_agg(
        ((item -> 'recipe') - 'created_at' - 'updated_at')
        || jsonb_build_object('created_at', now(), 'updated_at', now()))
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
    source_url          = excluded.source_url;

  -- 2) Replace children wholesale, set-based (refs cascade off the
  --    instructions delete; the owner triggers re-stamp on insert).
  delete from public.ingredients where recipe_id = any (v_ids);
  delete from public.instructions where recipe_id = any (v_ids);

  insert into public.ingredients
  select * from jsonb_populate_recordset(null::public.ingredients,
    (select coalesce(jsonb_agg(ing), '[]'::jsonb)
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
