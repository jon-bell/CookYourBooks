-- Cookbooks with an ISBN can't be made public.
--
-- An ISBN means the recipes are someone else's copyrighted work — the
-- owner can collect them privately for their own use, but publishing
-- that table of contents (or, by fork, the full recipes) to other
-- users would be a copyright violation. We enforce at the DB level so
-- a hand-crafted JS request can't bypass the UI dialog.

create or replace function public.enforce_no_public_isbn_cookbook()
returns trigger
language plpgsql
as $$
begin
  if new.is_public
    and new.source_type = 'PUBLISHED_BOOK'
    and new.isbn is not null
    and btrim(new.isbn) <> '' then
    raise exception
      'Cookbooks with an ISBN cannot be made public — their recipes belong to the publisher.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger enforce_no_public_isbn_cookbook_trg
  before insert or update of is_public, isbn, source_type
  on public.recipe_collections
  for each row execute function public.enforce_no_public_isbn_cookbook();
