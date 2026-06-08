-- Relaxed, better-ranked nutrition food search (v2).
--
-- The v1 search_nutrition_foods (20260608000100) used
-- websearch_to_tsquery, which ANDs every term. A messy ingredient name
-- like "plain full-fat yogurt" then required plain AND full AND fat AND
-- yogurt — the clean generic row "Yogurt, plain, whole milk" lacks the
-- "full"/"fat" lexemes, so it was excluded entirely and only a Branded
-- "PLAIN OATGURT NON-DAIRY FULL-FAT YOGURT ALTERNATIVE" matched all four
-- words and won. And "garlic cloves, minced" matched nothing at all.
--
-- v2 retrieves on an OR of the lexemes (any term can match) and then
-- ranks with a layered ORDER BY: generic tiers always above Branded,
-- calorie-bearing rows above null-calorie, full-coverage (all query
-- terms present) above partial, then textual rank, then a specificity
-- penalty that favours short generic descriptions ("Yogurt, plain" over
-- "Candies, confectioner's coating, yogurt"). Callers that want a clean
-- auto-match pass p_generic_only => true to drop Branded at the SQL
-- level (and hit the partial index, never scanning the 455k Branded
-- partition).
--
-- The query string is expected to be pre-cleaned by the shared
-- extractIngredientTerms / ingredientSearchQuery helper
-- (packages/domain/src/services/ingredientTerms.ts, ported to
-- supabase/functions/nutrition/_ingredientTerms.ts).

-- Distinct-lexeme set of just the description, so the ranking can count
-- "extra" tokens the food carries beyond the query (specificity). The
-- existing search_tsv is weighted (A/C/D across description/brand/
-- brand_owner) and unsuitable for a raw lexeme count. Adding a stored
-- generated column rewrites the table once — acceptable for read-only
-- reference data with no concurrent writers (the loader is the only
-- writer and runs offline).
alter table public.nutrition_foods_master
  add column if not exists desc_lexemes tsvector
  generated always as (to_tsvector('english', coalesce(description, ''))) stored;

-- Partial GIN so the hot p_generic_only path is index-driven over the
-- ~13.5k generic rows and never touches Branded.
create index if not exists nutrition_foods_master_generic_search_idx
  on public.nutrition_foods_master using gin (search_tsv)
  where data_type <> 'Branded';

-- New signature (adds p_generic_only). Drop the old 2-arg overload so
-- callers bind the new function unambiguously; the edge function moves
-- to the 3-arg call in the same deploy.
drop function if exists public.search_nutrition_foods(text, int);

create or replace function public.search_nutrition_foods(
  p_query text,
  p_limit int default 10,
  p_generic_only boolean default false
)
returns setof public.nutrition_foods_master
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- AND query is used only for the coverage bonus + token count.
  v_and tsquery := plainto_tsquery('english', coalesce(p_query, ''));
  -- Retrieval query: same lexemes, OR-combined. plainto_tsquery only
  -- ever emits ' & ' between lexemes, so the text swap is safe.
  v_or tsquery := nullif(replace(v_and::text, ' & ', ' | '), '')::tsquery;
  -- Number of query lexemes, for the specificity penalty denominator.
  v_n int := coalesce(array_length(string_to_array(nullif(v_and::text, ''), ' & '), 1), 0);
  -- The query's head food noun = its last word (extractIngredientTerms
  -- orders terms head-final: "olive oil", "whole milk", "kosher salt").
  -- USDA generic descriptions are head-FIRST ("Oil, olive", "Milk,
  -- whole", "Salt, table"), so a description that *starts with* the head
  -- noun is almost always the canonical generic for that food — the
  -- single strongest signal, and the fix for tier-first picking
  -- "Nuts, almonds, … with salt added" over "Salt, table".
  v_head text := lower(regexp_replace(btrim(coalesce(p_query, '')), '^.*\s', ''));
begin
  if v_or is null then
    return;  -- query was empty / all stopwords
  end if;

  -- Ranking rationale (both branches share it; the generic branch just
  -- drops Branded up front so it hits the partial index):
  --   1. all query terms present (full coverage) — exact-ish match
  --   2. description starts with the head food noun (USDA head-first)
  --   3. has calories (USDA stores energy separately; null = useless)
  --   4. textual relevance over the OR query (partial coverage)
  --   5. specificity: fewer extra description tokens = better generic
  --   6. tier: Foundation > SR Legacy > Survey > Branded (tiebreaker)
  --   7. brand-house entries last; stable source_id
  -- Tier is deliberately LOW: a concise on-topic SR Legacy row should
  -- beat a Foundation row that merely happens to contain a query word.
  if p_generic_only then
    return query
      select f.*
      from public.nutrition_foods_master f
      where f.data_type <> 'Branded'
        and f.search_tsv @@ v_or
      order by
        (f.search_tsv @@ v_and) desc,
        (v_head <> '' and lower(f.description) like v_head || '%') desc,
        (f.calories_kcal is null) asc,
        ts_rank_cd(f.search_tsv, v_or) desc,
        (length(f.desc_lexemes) - v_n) asc,
        case f.data_type
          when 'Foundation' then 0
          when 'SR Legacy' then 1
          when 'Survey (FNDDS)' then 2
          else 99
        end asc,
        f.source_id asc
      limit greatest(p_limit, 1);
  else
    return query
      select f.*
      from public.nutrition_foods_master f
      where f.search_tsv @@ v_or
      order by
        (f.search_tsv @@ v_and) desc,
        (v_head <> '' and lower(f.description) like v_head || '%') desc,
        (f.calories_kcal is null) asc,
        ts_rank_cd(f.search_tsv, v_or) desc,
        (length(f.desc_lexemes) - v_n) asc,
        case f.data_type
          when 'Foundation' then 0
          when 'SR Legacy' then 1
          when 'Survey (FNDDS)' then 2
          when 'Branded' then 3
          else 99
        end asc,
        (f.brand_owner is not null) asc,
        f.source_id asc
      limit greatest(p_limit, 1);
  end if;
end;
$$;

grant execute on function public.search_nutrition_foods(text, int, boolean)
  to anon, authenticated, service_role;
