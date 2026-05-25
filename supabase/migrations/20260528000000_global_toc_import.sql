-- Import paths into the global cookbook catalog.
--
-- Two RPCs that both copy a user's `recipe_collections` row + its
-- recipes into `global_cookbooks` / `global_toc_entries`:
--
--   1. `global_toc_admin_import(source_collection_id)` — admin sweeps a
--      user cookbook into the catalog. Requires an ISBN (that's the
--      global keying / dedupe column). First-write-wins on ISBN clash.
--
--   2. `global_toc_share_collection(source_collection_id)` — owner
--      promotes their own cookbook into the catalog. ISBN is optional
--      (handles community / family / one-off books). Idempotent on
--      re-share: keyed by `shared_from_collection_id` so subsequent
--      calls overwrite the cookbook's row + entries in place.

-- Provenance column. Lets users re-sync a previously-shared cookbook
-- without polluting the catalog, and lets the admin import page show
-- "already imported / by whom" without a separate audit table.
alter table public.global_cookbooks
  add column shared_from_collection_id uuid
    references public.recipe_collections(id) on delete set null;

-- Admins need to read every user's recipes for the import page's
-- candidate count and for the actual import RPC (which copies recipe
-- titles into global_toc_entries). The existing policies scope to
-- owner / public; the moderation migration extended collections but
-- not recipes — fix that here so admin-driven views and RPCs see the
-- full row set under RLS without us having to mark every helper
-- SECURITY DEFINER.
create policy "recipes_admin_read" on public.recipes
  for select using (public.is_admin(auth.uid()));

-- One global entry per source collection. Non-partial: PostgreSQL
-- still allows multiple NULLs in a UNIQUE column by default, and a
-- non-partial index is what `ON CONFLICT (shared_from_collection_id)`
-- below needs to bind to.
create unique index global_cookbooks_shared_from_unique
  on public.global_cookbooks(shared_from_collection_id);

-- Helper: normalize ISBN the same way the frontend does — strip
-- dashes / spaces, uppercase any trailing X. Returns null for null /
-- blank input so it composes cleanly with `nullif`.
create or replace function public.normalize_isbn(raw text)
returns text
language sql
immutable
as $$
  select case
    when raw is null or btrim(raw) = '' then null
    else upper(regexp_replace(raw, '[\s\-]', '', 'g'))
  end;
$$;

-- Shared internals: copy recipes → global_toc_entries. Page numbers on
-- the source recipe are a jsonb int[]; we lift the first one (the most
-- common pattern — multi-page recipes usually run consecutively from
-- the listed start page).
create or replace function public.global_toc_replace_entries_from_collection(
  target_cookbook_id uuid,
  source_collection_id uuid
) returns void
language plpgsql
as $$
begin
  delete from public.global_toc_entries where cookbook_id = target_cookbook_id;
  insert into public.global_toc_entries (cookbook_id, title, page_number, sort_order)
    select
      target_cookbook_id,
      r.title,
      nullif(r.page_numbers->>0, '')::int,
      coalesce(r.sort_order, 0)
    from public.recipes r
    where r.collection_id = source_collection_id
    order by r.sort_order, r.created_at;
end;
$$;

-- ---------- Admin import ----------

create or replace function public.global_toc_admin_import(
  source_collection_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  source public.recipe_collections%rowtype;
  norm_isbn text;
  cb_id uuid;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  select * into source
    from public.recipe_collections
    where id = source_collection_id;
  if not found then
    raise exception 'Source collection not found' using errcode = '42P01';
  end if;
  if source.source_type <> 'PUBLISHED_BOOK' then
    raise exception 'Only cookbook collections can be imported (got %)', source.source_type
      using errcode = '22023';
  end if;

  norm_isbn := public.normalize_isbn(source.isbn);
  if norm_isbn is null then
    raise exception 'Source collection has no ISBN; admin imports require one'
      using errcode = '22023';
  end if;

  insert into public.global_cookbooks
    (isbn, title, author, publisher, publication_year, cover_image_path,
      shared_from_collection_id)
    values
    (norm_isbn, source.title, source.author, source.publisher,
      source.publication_year, source.cover_image_path, source_collection_id)
    on conflict (isbn) do nothing
    returning id into cb_id;

  if cb_id is null then
    raise exception 'A global cookbook with ISBN % already exists', norm_isbn
      using errcode = '23505';
  end if;

  perform public.global_toc_replace_entries_from_collection(cb_id, source_collection_id);
  return cb_id;
end;
$$;

grant execute on function public.global_toc_admin_import(uuid) to authenticated;

-- ---------- Owner share ----------

create or replace function public.global_toc_share_collection(
  source_collection_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  source public.recipe_collections%rowtype;
  norm_isbn text;
  cb_id uuid;
begin
  select * into source
    from public.recipe_collections
    where id = source_collection_id;
  if not found then
    raise exception 'Source collection not found' using errcode = '42P01';
  end if;
  if source.owner_id <> auth.uid() then
    raise exception 'Only the owner can share this collection' using errcode = '42501';
  end if;
  if source.source_type <> 'PUBLISHED_BOOK' then
    raise exception 'Only cookbook collections can be shared globally'
      using errcode = '22023';
  end if;

  norm_isbn := public.normalize_isbn(source.isbn);

  -- ISBN, if present, is still globally unique. We refuse to overwrite
  -- a different collection's claim on the same ISBN — that would let
  -- the second sharer silently take over the first sharer's entry.
  if norm_isbn is not null then
    if exists (
      select 1 from public.global_cookbooks
       where isbn = norm_isbn
         and (shared_from_collection_id is null
              or shared_from_collection_id <> source_collection_id)
    ) then
      raise exception 'ISBN % is already in the global catalog from a different source', norm_isbn
        using errcode = '23505';
    end if;
  end if;

  insert into public.global_cookbooks
    (isbn, title, author, publisher, publication_year, cover_image_path,
      shared_from_collection_id)
    values
    (norm_isbn, source.title, source.author, source.publisher,
      source.publication_year, source.cover_image_path, source_collection_id)
    on conflict (shared_from_collection_id) do update set
      isbn = excluded.isbn,
      title = excluded.title,
      author = excluded.author,
      publisher = excluded.publisher,
      publication_year = excluded.publication_year,
      cover_image_path = excluded.cover_image_path,
      updated_at = now()
    returning id into cb_id;

  perform public.global_toc_replace_entries_from_collection(cb_id, source_collection_id);
  return cb_id;
end;
$$;

grant execute on function public.global_toc_share_collection(uuid) to authenticated;

-- ---------- Candidate list for the admin import page ----------
--
-- Returns user cookbooks with an ISBN that aren't yet in the global
-- catalog. Admins can read all `recipe_collections` rows (via the
-- existing `collections_admin_all` policy), so this is a plain view —
-- non-admins simply see an empty result.
create or replace view public.admin_global_toc_import_candidates
with (security_invoker = true) as
  select
    rc.id as collection_id,
    rc.title,
    rc.author,
    rc.isbn as raw_isbn,
    public.normalize_isbn(rc.isbn) as isbn,
    rc.publisher,
    rc.publication_year,
    rc.cover_image_path,
    rc.owner_id,
    p.display_name as owner_name,
    (select count(*) from public.recipes r where r.collection_id = rc.id) as recipe_count,
    rc.created_at
  from public.recipe_collections rc
  join public.profiles p on p.id = rc.owner_id
  where rc.source_type = 'PUBLISHED_BOOK'
    and public.normalize_isbn(rc.isbn) is not null
    and not exists (
      select 1 from public.global_cookbooks gc
      where gc.isbn = public.normalize_isbn(rc.isbn)
    );

grant select on public.admin_global_toc_import_candidates to authenticated;
