-- Trigram GIN index on nutrition_foods_master.description.
--
-- After Branded (455k rows) lands, `ILIKE '%keyword%'` queries from
-- the aggregation script and admin tooling time out under the
-- default statement_timeout — Postgres falls back to a full sequential
-- scan because the existing b-tree on description doesn't help with
-- leading-wildcard patterns. pg_trgm makes ILIKE ~instant.

create extension if not exists pg_trgm;

create index if not exists nutrition_foods_master_desc_trgm_idx
  on public.nutrition_foods_master using gin (description gin_trgm_ops);
