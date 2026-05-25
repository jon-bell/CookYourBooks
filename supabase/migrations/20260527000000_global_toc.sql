-- Global cookbook catalog + table-of-contents entries.
--
-- A curated, public-readable library of "we know this cookbook exists"
-- records keyed by ISBN. Each global cookbook has a list of recipe
-- titles (with optional page numbers) — what you'd read on the
-- cookbook's own table-of-contents page.
--
-- Purpose:
--   - Seed a user's collection from a known cookbook without OCRing the
--     ToC page-by-page (planned read path; not wired up in this PR).
--   - Provide a corpus the OCR pipeline can fuzzy-match against to
--     correct misreads of recipe titles.
--
-- Access:
--   - Anyone (incl. anon) can read.
--   - Only admins (existing `admins` table + `is_admin()`) can write.
--
-- Cover storage:
--   - Covers go in the existing `covers` bucket under the `global/`
--     prefix. The `covers_write_own` policy keys on user-id folders, so
--     we add an orthogonal admin grant for the `global/` prefix below.

-- ---------- global_cookbooks ----------

create table public.global_cookbooks (
  id uuid primary key default gen_random_uuid(),
  isbn text unique,
  title text not null,
  author text,
  publisher text,
  publication_year int,
  cover_image_path text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index global_cookbooks_title_idx on public.global_cookbooks(title);

alter table public.global_cookbooks enable row level security;

create policy "global_cookbooks_read_all" on public.global_cookbooks
  for select using (true);

create policy "global_cookbooks_admin_write" on public.global_cookbooks
  for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create trigger global_cookbooks_updated
  before update on public.global_cookbooks
  for each row execute function public.touch_updated_at();

-- ---------- global_toc_entries ----------

create table public.global_toc_entries (
  id uuid primary key default gen_random_uuid(),
  cookbook_id uuid not null references public.global_cookbooks(id) on delete cascade,
  title text not null,
  page_number int,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index global_toc_entries_cookbook_idx
  on public.global_toc_entries(cookbook_id, sort_order);

alter table public.global_toc_entries enable row level security;

create policy "global_toc_entries_read_all" on public.global_toc_entries
  for select using (true);

create policy "global_toc_entries_admin_write" on public.global_toc_entries
  for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create trigger global_toc_entries_updated
  before update on public.global_toc_entries
  for each row execute function public.touch_updated_at();

-- ---------- Storage: admin write under covers/global/ ----------
--
-- The existing `covers_write_own` policy only lets users write under
-- a folder named for their own user id. Global cookbook covers live
-- under `global/<cookbook_id>.<ext>`, so we add a parallel admin grant.
-- Reads are already covered by `covers_read_all`.

create policy "covers_write_global_admin" on storage.objects
  for insert
  with check (
    bucket_id = 'covers'
    and (storage.foldername(name))[1] = 'global'
    and public.is_admin(auth.uid())
  );

create policy "covers_update_global_admin" on storage.objects
  for update
  using (
    bucket_id = 'covers'
    and (storage.foldername(name))[1] = 'global'
    and public.is_admin(auth.uid())
  );

create policy "covers_delete_global_admin" on storage.objects
  for delete
  using (
    bucket_id = 'covers'
    and (storage.foldername(name))[1] = 'global'
    and public.is_admin(auth.uid())
  );
