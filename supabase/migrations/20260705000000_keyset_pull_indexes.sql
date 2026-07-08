-- Keyset-pull indexes for the incremental "tail" sync pulls.
--
-- The tail topics (rewrite_jobs, remix_jobs, cooking_events, recipe_tags,
-- collection_notes, conversion_rules, the four import sub-tables, and the
-- household variants) move from a bare `updated_at >= watermark` pull to a
-- strictly-greater keyset cursor on (updated_at, id) — the same shape recipes
-- and recipe_embeddings already use. The old `gte` pull re-fetched the boundary
-- row (or, for import_toc_entries, the whole 100+-row TOC block that shares one
-- bulk-insert updated_at) every cycle, because a bare ms watermark can't advance
-- past a block sharing one timestamp. The keyset walks past it via the id
-- tiebreaker and re-fetches nothing.
--
-- Each keyset page is `where owner_id = ? [and (updated_at,id) > cursor] order by
-- updated_at, id limit N`, so it needs a leading (owner_id, updated_at, id)
-- index or deep pages — notably the one-time full re-pull when an existing
-- device first establishes the keyset cursor — seq-scan + sort and risk the 8s
-- statement timeout (this is exactly why 20260626000400 shipped
-- recipe_embeddings_owner_pull_idx).
--
-- conversion_rules / cooking_events / recipe_tags / collection_notes already
-- carry an (owner_id, updated_at) index, which is sufficient for their small
-- same-timestamp blocks, so only the tables that lack one are added here.

-- Owned tail pulls keyed on updated_at.
create index if not exists rewrite_jobs_owner_pull_idx
  on public.rewrite_jobs (owner_id, updated_at, id);
create index if not exists remix_jobs_owner_pull_idx
  on public.remix_jobs (owner_id, updated_at, id);
create index if not exists import_batches_owner_pull_idx
  on public.import_batches (owner_id, updated_at, id);
create index if not exists import_items_owner_pull_idx
  on public.import_items (owner_id, updated_at, id);
create index if not exists import_toc_entries_owner_pull_idx
  on public.import_toc_entries (owner_id, updated_at, id);

-- import_item_attempts is append-only and keysets on started_at, not updated_at.
create index if not exists import_item_attempts_owner_pull_idx
  on public.import_item_attempts (owner_id, started_at, id);

-- Household (co-member) tail pulls: filtered by household_id (+ owner_id <> me),
-- keyed on updated_at. Partial on the shared rows, mirroring the existing
-- household_id partial indexes.
create index if not exists cooking_events_household_pull_idx
  on public.cooking_events (household_id, updated_at, id)
  where household_id is not null;
create index if not exists recipe_tags_household_pull_idx
  on public.recipe_tags (household_id, updated_at, id)
  where household_id is not null;
create index if not exists collection_notes_household_pull_idx
  on public.collection_notes (household_id, updated_at, id)
  where household_id is not null;
