-- CLI table-of-contents operations.
--
-- A "ToC" here = the titles-only skeleton of a collection. Useful when
-- you've just acquired a cookbook and want to seed placeholder recipes
-- for every entry before filling any of them in, or when you want a
-- light export to skim the library outside the app.
--
-- Both RPCs reuse `cli_verify_token` and scope strictly to the caller's
-- own collections, like the rest of the `cli_*` surface.

-- ---------- Export ----------

-- Returns {exported_at, owner_id, collections: [...]} where each
-- collection carries the cookbook-identifying metadata (author, isbn,
-- …) and a `recipes` array of {id, title, sort_order}. If
-- `collection_id` is non-null, scopes to that one collection.
create or replace function public.cli_export_toc(
  raw_token text,
  collection_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  collections jsonb;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;

  if collection_id is not null then
    perform 1 from public.recipe_collections
      where id = collection_id and owner_id = owner;
    if not found then
      raise exception 'Collection not found or not owned by caller'
        using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(col order by col_sort), '[]'::jsonb)
    into collections
  from (
    select rc.created_at as col_sort,
      jsonb_build_object(
        'id', rc.id,
        'title', rc.title,
        'source_type', rc.source_type,
        'is_public', rc.is_public,
        'author', rc.author,
        'isbn', rc.isbn,
        'publisher', rc.publisher,
        'publication_year', rc.publication_year,
        'recipes', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', r.id,
              'title', r.title,
              'sort_order', r.sort_order
            )
            order by r.sort_order, r.created_at
          )
          from public.recipes r
          where r.collection_id = rc.id
        ), '[]'::jsonb)
      ) as col
    from public.recipe_collections rc
    where rc.owner_id = owner
      and (cli_export_toc.collection_id is null or rc.id = cli_export_toc.collection_id)
  ) ranked;

  return jsonb_build_object(
    'exported_at', now(),
    'owner_id', owner,
    'collections', collections
  );
end;
$$;

grant execute on function public.cli_export_toc(text, uuid) to anon, authenticated;

-- ---------- Import ----------

-- Bulk-creates placeholder recipes (title only, no ingredients or
-- instructions) under an existing collection. Returns the array of new
-- recipe ids, in the same order as the input. Blank / whitespace-only
-- titles are skipped.
create or replace function public.cli_import_toc(
  raw_token text,
  target_collection_id uuid,
  titles text[]
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  starting_sort int;
  new_ids uuid[] := array[]::uuid[];
  clean_title text;
  next_sort int;
  new_recipe_id uuid;
  i int;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  if target_collection_id is null then
    raise exception 'target_collection_id is required' using errcode = '22023';
  end if;
  if titles is null or array_length(titles, 1) is null then
    return new_ids;
  end if;

  perform 1 from public.recipe_collections
    where id = target_collection_id and owner_id = owner;
  if not found then
    raise exception 'Target collection not found or not owned by caller'
      using errcode = '42501';
  end if;

  -- Append after any existing recipes so an iterative workflow doesn't
  -- collide with what's already been entered.
  select coalesce(max(sort_order), -1) + 1 into starting_sort
    from public.recipes where collection_id = target_collection_id;

  next_sort := starting_sort;
  for i in 1 .. array_length(titles, 1) loop
    clean_title := btrim(coalesce(titles[i], ''));
    continue when clean_title = '';

    insert into public.recipes (collection_id, title, sort_order)
      values (target_collection_id, clean_title, next_sort)
      returning id into new_recipe_id;
    new_ids := new_ids || new_recipe_id;
    next_sort := next_sort + 1;
  end loop;

  return new_ids;
end;
$$;

grant execute on function public.cli_import_toc(text, uuid, text[]) to anon, authenticated;
