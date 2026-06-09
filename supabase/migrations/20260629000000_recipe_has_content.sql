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
