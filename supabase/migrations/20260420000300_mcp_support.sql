-- MCP server support.
--
-- Backs the `apps/web/api/mcp.ts` edge function that exposes a
-- Model Context Protocol surface so AI assistants (Claude Desktop,
-- Claude Code, etc.) can read library/recipes and manage a
-- per-user shopping list. Everything the MCP touches goes through
-- `cli_verify_token` and is scoped to the token's owner — no admin,
-- no cross-user access.
--
-- Two kinds of additions:
--
--   1. New `cli_*` RPCs filling gaps that the MCP needs and the CLI
--      doesn't currently cover: single-recipe fetch, and recipe search
--      across the caller's own library.
--
--   2. A `shopping_list_items` table plus CRUD RPCs. This is a
--      separate surface from the web app's recipe-aggregation shopping
--      view — which is computed on the fly from selected recipes —
--      and intentionally so. The MCP needs something *writable* and
--      persistent; "add eggs to my shopping list" is meaningless
--      against the derived aggregation.

-- ---------- Single-recipe fetch ----------

-- Returns one recipe (with its ingredients / instructions / refs)
-- in the same shape `cli_export_library` uses per-recipe. Handy for
-- an MCP `get_recipe` tool that should not have to pull the entire
-- library to answer "what's in recipe X".
create or replace function public.cli_get_recipe(
  raw_token text,
  recipe_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  result jsonb;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', r.id,
    'title', r.title,
    'notes', r.notes,
    'parent_recipe_id', r.parent_recipe_id,
    'collection_id', r.collection_id,
    'collection_title', rc.title,
    'servings_amount', r.servings_amount,
    'servings_description', r.servings_description,
    'sort_order', r.sort_order,
    'ingredients', coalesce((
      select jsonb_agg(to_jsonb(i.*) - 'recipe_id' order by i.sort_order)
      from public.ingredients i where i.recipe_id = r.id
    ), '[]'::jsonb),
    'instructions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', ins.id,
          'step_number', ins.step_number,
          'text', ins.text,
          'ingredient_refs', coalesce((
            select jsonb_agg(ref.ingredient_id)
            from public.instruction_ingredient_refs ref
            where ref.instruction_id = ins.id
          ), '[]'::jsonb)
        )
        order by ins.step_number
      )
      from public.instructions ins where ins.recipe_id = r.id
    ), '[]'::jsonb)
  )
  into result
  from public.recipes r
  join public.recipe_collections rc on rc.id = r.collection_id
  where r.id = recipe_id and rc.owner_id = owner;

  if result is null then
    raise exception 'Recipe not found or not owned by caller' using errcode = '42501';
  end if;

  return result;
end;
$$;

grant execute on function public.cli_get_recipe(text, uuid) to anon, authenticated;

-- ---------- Recipe search ----------

-- Case-insensitive substring search across the caller's own recipes,
-- matching on recipe title OR any ingredient name. Returns a lean
-- `[{collection_id, collection_title, recipe_id, recipe_title}]` list
-- suitable for an MCP `search_recipes` tool — callers can follow up
-- with `cli_get_recipe` on any hit they want the full payload for.
create or replace function public.cli_search_recipes(
  raw_token text,
  query text,
  max_results integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  q text;
  capped integer;
  hits jsonb;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  q := btrim(coalesce(query, ''));
  if q = '' then
    return '[]'::jsonb;
  end if;
  capped := greatest(1, least(coalesce(max_results, 25), 100));

  select coalesce(jsonb_agg(row_to_json(h)), '[]'::jsonb)
    into hits
  from (
    select distinct r.id as recipe_id,
                    r.title as recipe_title,
                    rc.id as collection_id,
                    rc.title as collection_title
    from public.recipes r
    join public.recipe_collections rc on rc.id = r.collection_id
    left join public.ingredients i on i.recipe_id = r.id
    where rc.owner_id = owner
      and (r.title ilike '%' || q || '%' or i.name ilike '%' || q || '%')
    order by r.title asc
    limit capped
  ) h;

  return hits;
end;
$$;

grant execute on function public.cli_search_recipes(text, text, integer) to anon, authenticated;

-- ---------- Shopping list items ----------

create table public.shopping_list_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  quantity_text text,
  note text,
  -- Optional link back to the recipe the item was pulled from, so the
  -- UI (and future tools) can show "from X" attribution.
  recipe_id uuid references public.recipes(id) on delete set null,
  checked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index shopping_list_items_owner_idx
  on public.shopping_list_items(owner_id, checked, created_at desc);

alter table public.shopping_list_items enable row level security;

create policy "shopping_list_items_read_own" on public.shopping_list_items
  for select using (owner_id = auth.uid());
create policy "shopping_list_items_write_own" on public.shopping_list_items
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Realtime for the web app "Pantry" section so MCP-driven additions
-- appear instantly.
alter publication supabase_realtime add table public.shopping_list_items;

-- ---------- Shopping list RPCs ----------

create or replace function public.cli_list_shopping(raw_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(s) order by s.checked asc, s.created_at desc)
    from (
      select id, name, quantity_text, note, recipe_id, checked, created_at
      from public.shopping_list_items
      where owner_id = owner
    ) s
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.cli_list_shopping(text) to anon, authenticated;

create or replace function public.cli_add_shopping(
  raw_token text,
  name text,
  quantity_text text default null,
  note text default null,
  recipe_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  clean_name text;
  new_row public.shopping_list_items;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  clean_name := btrim(coalesce(name, ''));
  if clean_name = '' then
    raise exception 'name is required' using errcode = '22023';
  end if;

  -- If recipe_id is passed, make sure it belongs to the caller.
  -- Silently drop the link if the caller tries to reference someone
  -- else's recipe — the item still gets added, just unattributed.
  if recipe_id is not null then
    perform 1 from public.recipes r
      join public.recipe_collections rc on rc.id = r.collection_id
      where r.id = recipe_id and rc.owner_id = owner;
    if not found then
      recipe_id := null;
    end if;
  end if;

  insert into public.shopping_list_items
    (owner_id, name, quantity_text, note, recipe_id)
    values (owner, clean_name, nullif(btrim(coalesce(quantity_text, '')), ''),
            nullif(btrim(coalesce(note, '')), ''), recipe_id)
    returning * into new_row;

  return jsonb_build_object(
    'id', new_row.id,
    'name', new_row.name,
    'quantity_text', new_row.quantity_text,
    'note', new_row.note,
    'recipe_id', new_row.recipe_id,
    'checked', new_row.checked,
    'created_at', new_row.created_at
  );
end;
$$;

grant execute on function public.cli_add_shopping(text, text, text, text, uuid)
  to anon, authenticated;

create or replace function public.cli_check_shopping(
  raw_token text,
  item_id uuid,
  checked boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  updated_id uuid;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  update public.shopping_list_items
    set checked = cli_check_shopping.checked,
        updated_at = now()
    where id = item_id and owner_id = owner
    returning id into updated_id;
  if updated_id is null then
    raise exception 'Shopping item not found' using errcode = '42501';
  end if;
  return true;
end;
$$;

grant execute on function public.cli_check_shopping(text, uuid, boolean)
  to anon, authenticated;

create or replace function public.cli_remove_shopping(
  raw_token text,
  item_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  removed_id uuid;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  delete from public.shopping_list_items
    where id = item_id and owner_id = owner
    returning id into removed_id;
  if removed_id is null then
    raise exception 'Shopping item not found' using errcode = '42501';
  end if;
  return true;
end;
$$;

grant execute on function public.cli_remove_shopping(text, uuid)
  to anon, authenticated;

create or replace function public.cli_clear_shopping(
  raw_token text,
  only_checked boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  rowcount integer;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  if only_checked then
    delete from public.shopping_list_items
      where owner_id = owner and checked = true;
  else
    delete from public.shopping_list_items where owner_id = owner;
  end if;
  get diagnostics rowcount = row_count;
  return rowcount;
end;
$$;

grant execute on function public.cli_clear_shopping(text, boolean)
  to anon, authenticated;
