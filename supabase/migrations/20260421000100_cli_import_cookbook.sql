-- CLI: create a whole cookbook collection + ToC placeholder recipes in
-- one call.
--
-- Motivated by bulk-importing cookbook tables of contents (e.g. a batch
-- of Eat Your Books-shaped JSON dumps in `ToC/`). Each input file
-- describes a published cookbook and a long list of (title, page) pairs
-- for its recipes — no ingredients, no instructions, just an index.
--
-- The existing `cli_import_toc` needs an existing `target_collection_id`
-- and takes a bare `text[]` of titles, so it can't seed metadata or page
-- numbers. This RPC fills that gap with a single atomic call per
-- cookbook. Scopes, as always, to the token's owner.

create or replace function public.cli_import_cookbook(
  raw_token text,
  metadata jsonb,
  entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid := public.cli_verify_token(raw_token);
  col_id uuid;
  existing_id uuid;
  reused boolean := false;
  clean_title text;
  clean_author text;
  clean_isbn text;
  clean_publisher text;
  clean_year int;
  src_type text;
  next_sort int := 0;
  entry jsonb;
  page_val int;
  page_json jsonb;
  entry_title text;
  imported int := 0;
  skipped int := 0;
begin
  if owner is null then
    raise exception 'Invalid CLI token' using errcode = '42501';
  end if;
  if metadata is null or metadata->>'title' is null
     or btrim(metadata->>'title') = '' then
    raise exception 'metadata.title is required' using errcode = '22023';
  end if;

  clean_title    := btrim(metadata->>'title');
  clean_author   := nullif(btrim(coalesce(metadata->>'author', '')), '');
  clean_isbn     := nullif(btrim(coalesce(metadata->>'isbn', '')), '');
  clean_publisher := nullif(btrim(coalesce(metadata->>'publisher', '')), '');
  clean_year     := nullif(metadata->>'publication_year', '')::int;
  src_type       := coalesce(nullif(btrim(coalesce(metadata->>'source_type', '')), ''),
                             'PUBLISHED_BOOK');
  if src_type not in ('PUBLISHED_BOOK', 'PERSONAL', 'WEBSITE') then
    raise exception 'Invalid source_type %', src_type using errcode = '22023';
  end if;

  -- Dedup: prefer ISBN when present, else (title, author). This keeps
  -- re-runs of the bulk importer idempotent without the script needing
  -- to query first.
  if clean_isbn is not null then
    select id into existing_id
      from public.recipe_collections
      where owner_id = owner and isbn = clean_isbn
      limit 1;
  else
    select id into existing_id
      from public.recipe_collections
      where owner_id = owner
        and lower(title) = lower(clean_title)
        and lower(coalesce(author, '')) = lower(coalesce(clean_author, ''))
      limit 1;
  end if;

  if existing_id is not null then
    col_id := existing_id;
    reused := true;
    skipped := coalesce(jsonb_array_length(entries), 0);
  else
    insert into public.recipe_collections (
      owner_id, title, source_type, author, isbn, publisher, publication_year
    )
    values (owner, clean_title, src_type, clean_author, clean_isbn,
            clean_publisher, clean_year)
    returning id into col_id;
  end if;

  -- If the collection already existed, leave it alone — don't append
  -- possibly-duplicate recipes. Callers that want re-import semantics
  -- should delete the collection first.
  if not reused and entries is not null
     and jsonb_array_length(entries) > 0 then
    for entry in select * from jsonb_array_elements(entries) loop
      entry_title := btrim(coalesce(entry->>'title', ''));
      continue when entry_title = '';

      page_val := nullif(entry->>'page_number', '')::int;
      page_json := case when page_val is null
                        then null
                        else jsonb_build_array(page_val)
                   end;

      insert into public.recipes (collection_id, title, sort_order, page_numbers)
        values (col_id, entry_title, next_sort, page_json);
      next_sort := next_sort + 1;
      imported := imported + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'collection_id', col_id,
    'reused', reused,
    'imported', imported,
    'skipped', skipped
  );
end;
$$;

grant execute on function public.cli_import_cookbook(text, jsonb, jsonb)
  to anon, authenticated;
