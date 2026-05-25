-- One-way sync from the global catalog back to the source collection.
--
-- When an admin polishes a global_cookbooks row that's linked to a
-- user's recipe_collections (via shared_from_collection_id), the
-- non-empty fields propagate down to that source row. This lets a
-- shared-or-imported cookbook benefit from later admin edits (better
-- cover from Open Library, fixed title, added publisher) without the
-- user having to do anything.
--
-- Design rules:
--   1. NULL / blank values in the global row never overwrite the source.
--      Admin clearing a field shouldn't strip the user's data. Only
--      meaningful values propagate.
--   2. Sync runs SECURITY DEFINER so it bypasses recipe_collections RLS
--      — admin-write goes through `collections_admin_all`, but we want
--      this propagation to also fire for an owner who self-shares (their
--      RLS already lets them write their own row, but a trigger context
--      shouldn't depend on caller permissions).
--   3. Only the metadata + cover flow. Recipe lists (`global_toc_entries`)
--      do NOT push back — those would clobber the user's curated recipes.

create or replace function public.global_toc_propagate_to_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No-op if there's no source link, or if the link itself just changed
  -- on this UPDATE (a re-share rebinding is a write to the new source
  -- only — touching the old source's data would be surprising).
  if new.shared_from_collection_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (old.shared_from_collection_id is distinct from new.shared_from_collection_id) then
    return new;
  end if;

  update public.recipe_collections set
    title = coalesce(nullif(btrim(new.title), ''), title),
    author = coalesce(nullif(btrim(new.author), ''), author),
    publisher = coalesce(nullif(btrim(new.publisher), ''), publisher),
    publication_year = coalesce(new.publication_year, publication_year),
    isbn = coalesce(nullif(btrim(new.isbn), ''), isbn),
    cover_image_path = coalesce(nullif(btrim(new.cover_image_path), ''), cover_image_path)
    where id = new.shared_from_collection_id
      and source_type = 'PUBLISHED_BOOK';

  return new;
end;
$$;

-- Fires on every UPDATE (the import / share RPCs already populate the
-- source on first creation, so the AFTER INSERT case isn't needed —
-- the source row already has the data it just contributed).
create trigger global_toc_propagate_to_source_trg
  after update on public.global_cookbooks
  for each row execute function public.global_toc_propagate_to_source();
