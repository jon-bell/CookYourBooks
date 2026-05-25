-- Speed Importer: planner-driven OCR for ToC placeholders.
--
-- The user stars a ToC placeholder recipe (one with pageNumbers but no
-- ingredients/instructions, seeded from the global cookbook catalog),
-- then the /import/speed page walks them through scanning in page-number
-- order. Every shot uploads immediately as its own import_items row
-- pre-bound to the placeholder it targets, so the worker's OCR drafts
-- update those placeholders in place rather than landing as new recipes
-- the user has to back-match by fuzzy title.
--
-- This migration:
--   1. Adds `recipes.starred` so the planner queue can be derived from
--      the existing recipes table — no separate wishlist table needed.
--   2. Adds `import_items.assigned_recipe_id` so ImportItemPage can
--      bypass the fuzzy-match `matchedExisting` heuristic when the
--      planner already knows the answer.
--   3. Adds `import_batches.is_planner` so /import/speed can find an
--      in-progress planner session across app restarts.
--
-- No new RPCs. The existing import_finalize_grouping RPC already does
-- the AWAITING_GROUPING → PENDING flip + extras absorb the planner
-- needs at confirm time.

alter table public.recipes
  add column starred boolean not null default false;

-- Partial index — most recipes are not starred, so a partial keeps the
-- index small while still serving the planner's "give me starred
-- placeholders for cookbook X" query cheaply.
create index recipes_starred_idx on public.recipes(collection_id)
  where starred = true;

alter table public.import_items
  add column assigned_recipe_id uuid references public.recipes(id)
  on delete set null;

-- The planner is the only writer for this column, but the worker
-- preserves it; ImportItemPage reads it on save.
create index import_items_assigned_recipe_idx
  on public.import_items(assigned_recipe_id)
  where assigned_recipe_id is not null;

alter table public.import_batches
  add column is_planner boolean not null default false;
