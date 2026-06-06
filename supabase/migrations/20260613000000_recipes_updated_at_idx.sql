-- Index recipes.updated_at — the column every incremental sync pull
-- filters on.
--
-- The recipe-graph pull fetches `recipes where updated_at >= <watermark>`
-- and the child tables through `recipes!inner(... updated_at >= W)`.
-- Without an index on recipes.updated_at the planner can't find "rows
-- changed since W" directly: it drives from the owner's collections and
-- scans every recipe in them (and, for the children, scans to find the
-- changed parents), filtering updated_at after the fact. On a large
-- library + a small prod box that scan ran ~5–8s per pull and tripped
-- the statement timeout (57014), even though only one row had actually
-- changed.
--
-- With this index the planner seeks straight to the changed recipes
-- (cost on the child pull dropped ~603k → ~1k in EXPLAIN), so an
-- incremental pull is O(rows-changed) instead of O(library-size).
create index if not exists recipes_updated_at_idx
  on public.recipes(updated_at);
