-- Semantic fallback for ingredient → food matching.
--
-- When lexical search whiffs ("neutral oil" — no USDA row literally says
-- "neutral"), we cosine-match the ingredient against pre-embedded food
-- descriptions. Same gte-small (384-d) model as recipe search, so the
-- query vector (embedded at runtime in the nutrition edge function via
-- Supabase.ai) and the food vectors (backfilled by
-- scripts/embed-nutrition-foods.ts) are cosine-comparable.
--
-- We embed ONLY the generic tiers (Foundation / SR Legacy / Survey,
-- ~13.5k rows). Branded (455k) is excluded from auto-match, so there's
-- no reason to embed it — and an hnsw index over 455k vectors would be
-- far heavier than the payoff. Side table (not a column on
-- nutrition_foods_master) so the bulk loader stays untouched.

create extension if not exists vector;

create table public.nutrition_food_embeddings (
  source text not null,
  source_id text not null,
  embedding vector(384) not null,
  model text not null,
  updated_at timestamptz not null default now(),
  primary key (source, source_id),
  foreign key (source, source_id)
    references public.nutrition_foods_master(source, source_id) on delete cascade
);

-- All rows here are generic (we never embed Branded), so a plain hnsw
-- index over the whole table is the generic-only search index.
create index nutrition_food_embeddings_hnsw
  on public.nutrition_food_embeddings using hnsw (embedding vector_cosine_ops);

alter table public.nutrition_food_embeddings enable row level security;

-- Reference data — readable by everyone, like nutrition_foods_master.
-- Writes go through the service-role backfill script only (no write
-- policy for authenticated/anon).
create policy nutrition_food_embeddings_read on public.nutrition_food_embeddings
  for select to authenticated using (true);
create policy nutrition_food_embeddings_anon_read on public.nutrition_food_embeddings
  for select to anon using (true);

-- Nearest-neighbour search returning the full master row so the edge
-- function can reuse the same row → CachedFact mapper as the lexical
-- path. Vector arrives as real[] (PostgREST-friendly) and is cast to
-- vector(384) inside. Cosine distance via the <=> operator.
create or replace function public.search_nutrition_foods_semantic(
  p_embedding real[],
  p_limit int default 10
)
returns setof public.nutrition_foods_master
language sql
stable
security definer
set search_path = public
as $$
  select m.*
  from public.nutrition_food_embeddings e
  join public.nutrition_foods_master m
    on m.source = e.source and m.source_id = e.source_id
  where array_length(p_embedding, 1) = 384
  order by e.embedding <=> p_embedding::vector(384)
  limit greatest(p_limit, 1);
$$;

grant execute on function public.search_nutrition_foods_semantic(real[], int)
  to anon, authenticated, service_role;
