# Nutrition matching audit harness

Reproduces the measurements in `NUTRITION_AUDIT.md`, and is the same harness the
post-overhaul validation must re-run so before/after numbers are comparable.

`terms.ts` re-exports `supabase/functions/nutrition/_ingredientTerms.ts`, which
`scripts/sync-ingredient-terms.mjs` generates from the domain source. So the replay always
measures the extractor the app actually ships — there is nothing to re-copy. Run
`node scripts/sync-ingredient-terms.mjs` after changing the domain copy.

## Pipeline

    ./psql.sh "select 1"                  # prod SQL via Management API (~/.supabase/access-token)

    # 1. corpus -> corpus.json
    ./psql.sh "with ings as (select lower(trim(i->>'name')) as nm from recipes r,
       jsonb_array_elements(r.ingredients) i) select nm, count(*)::int c from ings
       where nm<>'' group by 1 order by 2 desc, 1" > corpus.json

    node --experimental-strip-types fullsql.mjs   # full-corpus replay batches -> full/
    for i in $(seq 0 20); do ./psql.sh -f full/b_$i.sql > full/o_$i.json; done
    jq -s 'add' full/o_*.json > full_replay.json
    node --experimental-strip-types metrics.mjs   # ranking defect rates
    node --experimental-strip-types grams.mjs     # end-to-end gram resolution

    # 2. graded sample
    node --experimental-strip-types sample.mjs    # stratified 300 (seeded, reproducible)
    node --experimental-strip-types mksql.mjs 50
    for i in $(seq 0 5); do ./psql.sh -f batch_$i.sql > out_$i.json; done
    jq -s 'add' out_*.json > replay.json
    node --experimental-strip-types enrich.mjs    # -> audit_dataset.json
    node --experimental-strip-types packets.mjs   # -> packet_0..5.md for the graders
    # hand packet_N.md + RUBRIC.md to 6 independent graders -> graded_N.json
    node --experimental-strip-types agg.mjs       # aggregate
    node --experimental-strip-types honest.mjs    # bounded rate (semantic fallback is unobservable)

The sample is seeded (PRNG seed 1337), so re-running picks the **same 300 ingredients** —
which is what makes the before/after comparison meaningful.

## Caveat that must survive into any re-run

Items on the `semantic_fallback` path are graded UNUSABLE by rubric construction: the
graders never see the semantic result. Report the **bound** (`honest.mjs`), not the point
estimate, or the overhaul will look better than it is.

## IMPORTANT — replay the path production actually uses

The first pass of this audit replayed `search_nutrition_foods` (the **server** RPC) and got a
misleadingly good number. `useRecipeNutrition` calls `searchLocalEssentials` first and only
reaches the server when that returns zero rows. The two rankers disagree on **80.6%** of
occurrences.

- `localsql.mjs` / `locpack.mjs` / `locpack2.mjs` / `locagg.mjs` replay the **local**
  (production) path — Foundation + SR Legacy only, `LIKE '%term%'` substring, tier-first.
  **These are the primary harness.**
- `fullsql.mjs` / `mksql.mjs` / `agg.mjs` replay the **server** path — useful for comparison
  and for the fallback, but not the live matcher.
- `semsql.mjs` / `sempack.mjs` / `semagg.mjs` replay the semantic path (needs `embed.mjs`
  first; run it from the repo root so `@huggingface/transformers` resolves).

Sanity check before trusting any semantic run: embed an exact food description and confirm it
self-retrieves at cosine 1.0000. That is what proves the local vectors are comparable to the
stored ones.

## Post-overhaul harness (2026-09-14)

The scripts above measure the PRE-overhaul system. These measure the current one:

    sqlfrag.mjs        shared SQL fragments — the ORDER BY here must mirror
                       searchLocalEssentials in apps/web/src/nutrition/localCache.ts,
                       or the replay is measuring a different algorithm than the app runs
    newlocalsql.mjs    full-corpus replay of the new ranker      -> new_local_replay.json
    compare.mjs        before/after objective metrics (head-noun present, null calories)
    newpack.mjs        top-5 for the seeded 300                  -> new_sample.json
    newpack2.mjs       grading packets                           -> newpacket_0..5.md
    finalagg.mjs       before/after graded aggregate + regressions
    gramsfinal.mjs     end-to-end gram resolution, before vs after
    headcmp.mjs        compare ORDER BY variants on the 40 most frequent ingredients
    orderprobe.mjs     score ORDER BY variants against the 78 curated mappings

`orderprobe.mjs` exists because exact-source_id agreement with the curated table is a
**weak** proxy — two different rows are often both correct — so it ranks candidate orderings
but does not settle them. `headcmp.mjs` (eyeball the highest-frequency ingredients, which
dominate the occurrence-weighted score) is what actually decided the shipped ordering.

## Why there is no data in this directory

`.gitignore` excludes every generated `.json`, `.sql` and grading packet. This repo is
public and the corpus is every ingredient string in the production `recipes` table —
content belonging to real users, not only the developer. The scripts regenerate all of it
from prod in a few minutes; start at "Pipeline" above.
