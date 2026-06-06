-- Bulk, single-round-trip recipe-graph save + a missing collections index.
--
-- WHY (Finding 1 / 6 of the sync audit):
-- The outbox push wrote each recipe with FIVE-plus sequential PostgREST
-- round-trips: upsert recipe, delete ingredients, delete instructions,
-- insert ingredients, insert instructions, insert refs. On the 512MB /
-- fractional-CPU prod box each call also pays RLS WITH-CHECK + the
-- set_child_owner trigger per row. Approving a large Table-of-Contents
-- import (dozens of placeholder recipes, each enqueued as its own
-- recipe_save) therefore meant hundreds of serial calls that never
-- drained inside the 45s push cycle. It also left a non-atomic window
-- where children were deleted but not yet re-inserted.
--
-- save_recipes_graph collapses the whole batch into ONE call run in ONE
-- transaction. It is SECURITY INVOKER, so every statement is still gated
-- by the existing RLS policies exactly as the direct PostgREST writes
-- were — no bespoke ownership check to keep in sync. The child-owner
-- BEFORE INSERT triggers still fire and set owner_id, so the children's
-- `owner_id = (select auth.uid())` WITH CHECK passes for recipes whose
-- collection the caller owns, and fails otherwise.
--
-- Timestamps: there is no BEFORE INSERT trigger on recipes (only
-- touch_updated_at BEFORE UPDATE), so created_at/updated_at rely on the
-- column DEFAULT — which does NOT apply when the value is explicitly
-- NULL, and jsonb_populate_record supplies NULL for missing keys. We
-- therefore inject now() for both on the insert path; on the conflict
-- path created_at is never overwritten and touch_updated_at owns
-- updated_at.

create or replace function public.save_recipes_graph(p_recipes jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item jsonb;
  v_recipe jsonb;
  v_id uuid;
  v_set text;
begin
  if p_recipes is null or jsonb_typeof(p_recipes) <> 'array' then
    raise exception 'save_recipes_graph: p_recipes must be a jsonb array';
  end if;

  for v_item in select value from jsonb_array_elements(p_recipes)
  loop
    v_recipe := v_item -> 'recipe';
    if v_recipe is null or jsonb_typeof(v_recipe) <> 'object' then
      raise exception 'save_recipes_graph: each item needs a "recipe" object';
    end if;
    v_id := (v_recipe ->> 'id')::uuid;
    if v_id is null then
      raise exception 'save_recipes_graph: recipe missing id';
    end if;

    -- "col = excluded.col" for every recipe column the caller actually
    -- sent, except id/created_at/updated_at. Built from information_schema
    -- (not the raw jsonb keys) so a stray/hostile key can't be injected
    -- into the statement; %I quoting is belt-and-suspenders.
    select string_agg(format('%I = excluded.%I', c.column_name, c.column_name), ', ')
      into v_set
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'recipes'
       and c.column_name <> all (array['id', 'created_at', 'updated_at'])
       and v_recipe ? c.column_name;

    execute format(
      'insert into public.recipes '
      || 'select * from jsonb_populate_record(null::public.recipes, $1) '
      || 'on conflict (id) do update set %s',
      coalesce(v_set, 'title = excluded.title')
    )
    using ((v_recipe - 'created_at' - 'updated_at')
           || jsonb_build_object('created_at', now(), 'updated_at', now()));

    -- Replace children wholesale (refs cascade off the instructions
    -- delete). The BEFORE INSERT owner triggers re-stamp owner_id.
    delete from public.ingredients where recipe_id = v_id;
    delete from public.instructions where recipe_id = v_id;
    insert into public.ingredients
      select * from jsonb_populate_recordset(
        null::public.ingredients, coalesce(v_item -> 'ingredients', '[]'::jsonb));
    insert into public.instructions
      select * from jsonb_populate_recordset(
        null::public.instructions, coalesce(v_item -> 'instructions', '[]'::jsonb));
    insert into public.instruction_ingredient_refs
      select * from jsonb_populate_recordset(
        null::public.instruction_ingredient_refs, coalesce(v_item -> 'refs', '[]'::jsonb));
  end loop;
end;
$$;

revoke all on function public.save_recipes_graph(jsonb) from public;
grant execute on function public.save_recipes_graph(jsonb) to authenticated;

-- ============================================================
-- Finding 5: index the collections incremental-pull filter/sort.
-- ============================================================
-- The owned and household collection pulls both filter on owner_id and
-- order by updated_at (`where owner_id = ? and updated_at >= W order by
-- updated_at`). With only the single-column owner index the planner
-- seeks by owner but then sorts/filters updated_at in memory — the exact
-- pathology that tripped the statement timeout for recipes before
-- 20260613 added recipes_updated_at_idx. This is the collections analog.
create index if not exists recipe_collections_owner_updated_idx
  on public.recipe_collections(owner_id, updated_at);
