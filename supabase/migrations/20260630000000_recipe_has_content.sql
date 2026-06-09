-- recipes.has_content: server-owned "this recipe has real content" flag.
--
-- The library view sorts/labels collections by how many of their recipes have
-- actual content (>=1 ingredient or instruction) vs. bare catalog placeholders.
-- Computing that per-render with correlated EXISTS over the whole (household-
-- shared) recipe set held the single browser SQLite connection for minutes and
-- wedged sync (Sentry CYB-CAPACITOR-3). We materialize it instead.
--
-- Source of truth is Postgres: a statement-level trigger on ingredients /
-- instructions keeps recipes.has_content correct for every server write path
-- (save_recipes_graph, fork_collection, admin import, …) with no per-RPC edits.
-- It rides to devices on the normal recipe pull (select *) like any column.
-- Browsers also maintain it locally (cr-sqlite has no peer link through
-- Postgres) and backfill existing local rows once via the client migration
-- runner.

alter table public.recipes
  add column if not exists has_content boolean not null default false;

-- Recompute has_content for the recipes whose children changed in this
-- statement. Statement-level + transition tables so a bulk save_recipes_graph
-- (delete-all + insert-all) costs two set-based updates, not one per row.
-- The `is distinct from` guard avoids no-op updates (and the updated_at bump
-- the recipes_updated trigger would fire) when the boolean doesn't actually
-- change.
create or replace function public.recipes_refresh_has_content()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct recipe_id) into v_ids from new_rows;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct recipe_id) into v_ids from old_rows;
  else
    select array_agg(distinct rid) into v_ids
    from (
      select recipe_id as rid from new_rows
      union
      select recipe_id from old_rows
    ) u;
  end if;

  if v_ids is null then
    return null;
  end if;

  update public.recipes r
     set has_content = c.computed
  from (
    select rid,
           exists (select 1 from public.ingredients i where i.recipe_id = rid)
        or exists (select 1 from public.instructions s where s.recipe_id = rid) as computed
    from unnest(v_ids) as rid
  ) c
  where r.id = c.rid
    and r.has_content is distinct from c.computed;

  return null;
end;
$$;

-- Separate per-operation triggers: INSERT exposes only NEW TABLE, DELETE only
-- OLD TABLE, UPDATE both. The function references the matching name per branch.
drop trigger if exists ingredients_has_content_ins on public.ingredients;
drop trigger if exists ingredients_has_content_del on public.ingredients;
drop trigger if exists ingredients_has_content_upd on public.ingredients;
create trigger ingredients_has_content_ins after insert on public.ingredients
  referencing new table as new_rows
  for each statement execute function public.recipes_refresh_has_content();
create trigger ingredients_has_content_del after delete on public.ingredients
  referencing old table as old_rows
  for each statement execute function public.recipes_refresh_has_content();
create trigger ingredients_has_content_upd after update on public.ingredients
  referencing new table as new_rows old table as old_rows
  for each statement execute function public.recipes_refresh_has_content();

drop trigger if exists instructions_has_content_ins on public.instructions;
drop trigger if exists instructions_has_content_del on public.instructions;
drop trigger if exists instructions_has_content_upd on public.instructions;
create trigger instructions_has_content_ins after insert on public.instructions
  referencing new table as new_rows
  for each statement execute function public.recipes_refresh_has_content();
create trigger instructions_has_content_del after delete on public.instructions
  referencing old table as old_rows
  for each statement execute function public.recipes_refresh_has_content();
create trigger instructions_has_content_upd after update on public.instructions
  referencing new table as new_rows old table as old_rows
  for each statement execute function public.recipes_refresh_has_content();

-- save_recipes_graph inserts recipes via `insert ... select * from
-- jsonb_populate_recordset(...)`, which sets fields ABSENT from the payload to
-- NULL (not the column default). The client doesn't (and shouldn't) send
-- has_content, so the insert would write NULL and trip the NOT NULL constraint.
-- Redefine it to strip any client has_content and inject `false` on the insert
-- payload; the trigger above then flips it to true when the ingredient/
-- instruction inserts land. ON CONFLICT deliberately does NOT set has_content,
-- so a re-save preserves the trigger-managed value. Otherwise byte-identical to
-- 20260626000000.
create or replace function public.save_recipes_graph(p_recipes jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_recipes jsonb;
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

-- One-time backfill of existing rows. Suppress the recipes_updated trigger so
-- this does NOT bump updated_at — otherwise every device would re-pull every
-- recipe (watermark churn / first-sync wedge risk). Existing devices instead
-- compute has_content locally once via the client backfill runner; new pulls
-- carry the server value.
alter table public.recipes disable trigger recipes_updated;
update public.recipes r
   set has_content = exists (select 1 from public.ingredients i where i.recipe_id = r.id)
                  or exists (select 1 from public.instructions s where s.recipe_id = r.id)
 where r.has_content = false;
alter table public.recipes enable trigger recipes_updated;
