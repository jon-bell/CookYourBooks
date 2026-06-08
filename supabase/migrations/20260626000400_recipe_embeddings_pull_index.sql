-- Indexes for the recipe_embeddings sync pull.
--
-- The local-first client pulls recipe_embeddings by
--   owner pull:     where owner_id = ?  and updated_at >= ? order by updated_at, recipe_id
--   household pull: where household_id = ? and owner_id <> ? order by updated_at, recipe_id
-- but the table only had the HNSW vector index (20260605000100) and a
-- filter-only partial index on household_id (20260624000000). Neither supports
-- the ordered range scan, so the owner pull seq-scanned + sorted the owner's
-- whole vector set on every page. With OFFSET pagination that's O(offset) per
-- page, and on a full re-pull the deep pages (offset 1000/2000…) blew the 8s
-- statement timeout — 57014, surfaced as CYB-CAPACITOR-A and the cascading
-- "pull timed out after 45s" sync stall on iOS.
--
-- These composite indexes turn each page into an index range scan with the
-- sort satisfied by the index, which (paired with the client's switch to
-- keyset pagination) makes every page O(PAGE_SIZE) regardless of depth.

create index if not exists recipe_embeddings_owner_pull_idx
  on public.recipe_embeddings (owner_id, updated_at, recipe_id);

-- Supersedes recipe_embeddings_household_idx (household_id only): the leading
-- column still serves plain `household_id = ?` lookups, and the trailing
-- columns satisfy the ordered keyset scan.
create index if not exists recipe_embeddings_household_pull_idx
  on public.recipe_embeddings (household_id, updated_at, recipe_id)
  where household_id is not null;

drop index if exists public.recipe_embeddings_household_idx;

analyze public.recipe_embeddings;
