# Nutrition matching — audit of the system as it stands

**Date:** 2026-09-13 · **Measured against:** prod (`xdyhhycfolcpqdawfkcj`), full library, not a mock.

> **⚠️ CORRECTION — read Part 4 first.** Parts 1 and 2 replay `search_nutrition_foods`,
> the **server** RPC. Production calls `searchLocalEssentials` first and only reaches the
> server when that returns zero rows, so Parts 1–2 measure the *fallback* path. The
> structural findings there all still hold (and several get worse); the match-quality
> percentages do not describe production. **Part 4 has the real baseline: 31.3% usable.**
> Part 3 (gram conversion) is unaffected — `quantityToGrams` is shared by both paths.


Method: replayed the pipeline (`extractIngredientTerms` → `search_nutrition_foods(generic_only)`
→ `lexicalIsWeak` → semantic fallback) over **every** distinct ingredient string in prod
(6,082 names / 19,831 occurrences), then had six independent graders blind-score a stratified
300-item sample (150 most-common + 150 random long-tail) against a fixed rubric.

---

## 1. Headline

**Only 32.4% of ingredient occurrences resolve to both a usable food *and* a trustworthy gram weight.**

| outcome | occurrences | % |
|---|---:|---:|
| fully resolved | 6,419 | **32.4%** |
| grams are a water-density guess (cup/tbsp/tsp of flour, oil, sugar…) | 6,175 | 31.1% |
| no grams at all | 3,185 | 16.1% |
| VAGUE, no quantity | 2,922 | 14.7% |
| grams fine, food has no usable facts | 1,130 | 5.7% |

Match quality on the graded sample, stated as a **bound** (47/300 fell to the semantic
fallback, whose output the graders could not see — so the true figure sits inside this range):

| slice | usable (CORRECT+ACCEPTABLE) |
|---|---|
| observable decisions only (mapping + lexical, n=253) | **66.0%** (78.0% occurrence-weighted) |
| all 300, bounded | 55.7% – 71.3% (75.3% – 78.8% weighted) |
| **head** — 150 most common names | 74.0% |
| **tail** — random long-tail names | **37.3%** |

The tail is where the system falls apart, and the tail is most of the vocabulary.

---

## 2. The five root causes

### A. Ranking saturates, then ties are broken by arbitrary USDA id
For short queries every ORDER BY signal maxes out simultaneously. For `water`:

| description | coverage | head-prefix | ts_rank_cd | lexemes |
|---|---|---|---|---|
| Water Chesnut *(sic)* | true | true | 1.00000 | 2 |
| Water, tonic | true | true | 1.00000 | 2 |
| Water, NFS | true | true | 1.00000 | 2 |
| Water, tap | true | true | 1.00000 | 2 |

Nothing discriminates, so the final `source_id asc` tiebreak decides — and a USDA typo wins.
This is not a tuning problem; there is **no signal that says "this row *is* the food"** as
opposed to "this row merely starts with the word".

Consequences, at real frequency: `ground black pepper` (147×) → **Pepper steak**.
`warm water` (30×) → **Water Chestnut**. `boiling water` (23×) → **Water convolvulus**.
`hot water` (22×) → **hot cocoa made with water**.

`head_noun_coincidence` was the single most common failure mode (34 of 152).

### B. The Foundation tier is a nutritional landmine
**268 of 363 Foundation rows (73.8%) have NULL calories.** The ORDER BY places
coverage (1st) and head-prefix (2nd) *above* `calories_kcal is null` (3rd), so the cleanest,
most canonical-looking row wins and returns nothing.

Corpus-wide this silently zeroes **885 occurrences (4.5%)** — and it is *weighted toward the
most common ingredients* (4.5% weighted vs 2.4% unweighted). The victims are the fats:

    358x  extra-virgin olive oil  -> Oil, olive, extra virgin        (NULL kcal)
    217x  unsalted butter         -> Butter, stick, unsalted         (NULL kcal)
     19x  boneless, skinless chicken thighs                          (NULL kcal)

Production has already served 52 distinct null-calorie foods to real users — butter,
bell peppers, carrots, tomato paste, ground pork.

### C. The platform mapping table is a band-aid, and it is exact-string keyed
`resolve_nutrition_mapping` does raw `ingredient_key = p_ingredient_key` — no normalization.
It is also the *only* thing holding the head of the distribution up (92.9% usable on that
path vs 58.4% lexical). But 83 hand-curated rows cannot cover 6,082 names, and the keying
is brittle:

    MAPPED    "extra-virgin olive oil"   -> 884 kcal
    UNMAPPED  "extra virgin olive oil"   -> 0 kcal     <- same food, no hyphen

`red bell pepper`, `almond flour`, `roma tomatoes`, `button mushrooms` are all unmapped and
all land on NULL-calorie rows.

### D. Term extraction drops the food and keeps the modifier
23 of 152 failures. The head-noun heuristic ("last surviving food noun") picks the wrong word
when the real food is a container/part word that the drop-lists removed:

    "lemongrass stalks"      head -> (stalks dropped) -> branded Vietnamese soup
    "strained lime juice"    -> apple/grape juice blend; the "lime" signal is lost
    "cinnamon stick"         -> head becomes "stick"
    "lemon zest" / "basil leaves" / "lime wedges"  -> same class

Diacritics are destroyed outright — `tokenizeIngredient` does `replace(/[^a-z0-9]+/g,' ')`:

    "jalapeño"      -> "jalape"
    "crème fraîche" -> "cr me fra che"
    "tomato purée"  -> "tomato pur"
    "pâté"          -> ""            (empty; even the safety-net fallback yields nothing)

99 distinct names / 134 occurrences. Low volume, total failure, one-line fix (NFD normalize).

### E. Gram conversion is barely implemented
Even a perfect food match gives wrong numbers without grams.

- `piece` is the **most common unit in the library** (3,757 occ, 22% of MEASURED). **2,917 of
  those resolve to no grams at all.**
- **All 5,432 Survey (FNDDS) foods carry only numeric USDA measure-unit IDs** as the portion
  unit (`"90000"`, `"10205"`) — the ingest never resolved them to labels. 40% of the generic
  corpus has unusable portion data.
- Only **213 of 37,007** generic portion entries use a countable unit = **0.6%**.
  Garlic's sole portion is `{"unit":"racc","grams":85}` — RACC, not "1 clove" (~3 g). 28× off.
- `conversion_rules` (user density rules): **0 rows**. `global_conversions`: 102 rows, of which
  only **13** are `piece`. `custom_grams_per_unit`: **0 of 83** mappings populated.
- So volume → grams falls through to **water density** for every dry good.
  1 cup flour = 236 g; true ≈ 120 g. **A 2× error on the most common baking ingredient**,
  affecting 31.1% of all occurrences.

---

## 3. What this implies for the overhaul

**38% of genuinely-bad matches (50 of 133) had a better row already sitting in the top 5.**
That share is pure ranking — no new corpus, no embeddings, no LLM. It is the cheapest win
available and should be staged first.

Rough shape, in dependency order:

1. **Fix ranking** (biggest win / lowest cost). Add a real "this row *is* the food" signal —
   stemmed equality against the description's pre-comma head phrase, which already separates
   `Water, tap` from `Water Chesnut`. Move `calories_kcal is null` to a **hard filter**, not a
   sort key. Demote `racc`-only and brand-house rows. Penalise rows whose description head
   disagrees with the query head.
2. **Fix term extraction.** NFD-normalize before the ASCII strip. Stop treating part/container
   words (`stalk`, `zest`, `leaves`, `stick`, `wedge`) as pure noise when they are the only
   thing left — they are the food. Handle compound strings (`salt and pepper`) as two matches.
3. **Replace the 83-row mapping table with a normalized, generated alias layer** — key on the
   cleaned query, not the raw string, so hyphenation and word order stop mattering. Seed it
   from this corpus rather than by hand.
4. **Rebuild gram conversion**, which is the larger half of the error and currently the least
   built. Resolve the FNDDS measure-unit IDs to labels; ingest a real density table for
   volume→mass; give `piece` a per-food gram default.
5. **Re-validate exactly this way** — same replay harness, same rubric, same stratified sample,
   graded blind — so the before/after number is honest and comparable.

Everything in this document is reproducible: harness, corpus dump, per-item grades and the
6 grader packets are in the session scratchpad.

---

# Part 2 — Semantic path validation

Run because the Part 1 numbers left the semantic fallback unobserved, and that gap was
load-bearing for the architecture decision.

**Method.** Embedded all 300 sample queries locally with `Xenova/gte-small` q8, mean-pooled
and normalized — the *same loader and settings* `scripts/embed-nutrition-foods.ts` used to
build the stored vectors. Verified comparability by embedding an exact description and
confirming self-retrieval at **cosine 1.0000**. Then queried `search_nutrition_foods_semantic`
and had six fresh graders blind-score the picks on the same scale. Two query variants were
tested: **A** = cleaned terms (what prod embeds today), **B** = raw ingredient string.

## Result: semantic is not better, and cannot be gated

| path | usable, same 300 items | head | tail |
|---|---|---|---|
| lexical + mapping (observable n=253) | 66.0% | — | — |
| **semantic A on those same items** | **66.4%** | — | — |
| semantic A, all 300 | 62.3% | 74.0% | **50.7%** |
| semantic B (raw string), all 300 | 62.3% | — | — |
| *lexical, all 300* | *55.7% floor* | *74.0%* | *37.3%* |

- **Semantic ties lexical overall** (66.4% vs 66.0% — noise).
- **Semantic is materially better on the long tail** (50.7% vs 37.3%). That is where it earns
  its place, and it is the half of the vocabulary lexical handles worst.
- **Cleaned vs raw query is a wash** (62.3% both). Cleaning strips head nouns from "X or Y"
  lists (hurting A); raw strings drag parentheticals like "(for the filling)" into the
  embedding (hurting B). They trade roughly evenly.

### Cosine is not a usable confidence signal — measured two independent ways

Against the 78 hand-curated platform mappings as ground truth:

    semantic CORRECT picks: n=31  min=0.8962  median=0.9534
    semantic WRONG   picks: n=47  min=0.8269  median=0.9344
    41 of 47 WRONG picks score above 0.90.  Wrong picks reach cosine 1.0000.

All six graders concluded the same independently. A floor only catches true garbage
(`< ~0.82`: "sabzi khordan", "lavash", "wray & nephew overproof") — i.e. corpus gaps —
and is **completely blind to the null-calorie failure**, where unusable Foundation rows
score among the *highest* cosines in the set (chicken thigh 0.96, "Flour, 00" 0.94).

So "make semantic primary behind a similarity threshold" is not available. There is no
threshold to set.

### Where semantic actually sits today
Of the 47 items that currently fall through to the semantic fallback, semantic delivers a
usable answer on **19 (40.4%)**. That lifts the true system number above the Part 1 floor:

> **True current system = 62.0% usable (77.2% occurrence-weighted).**

## The ceiling on retrieval tuning

    ORACLE union (best of lexical OR semantic, with a perfect selector): 220/300 = 73.3%

Of the 114 real failures:

| | count | share |
|---|---:|---:|
| the *other* retrieval path has the right answer | 34 | 30% |
| **neither path has it** | **80** | **70%** |

**70% of remaining failures are data problems, not retrieval problems** — `corpus_missing_food`,
`null_calories_row_won`, `wrong_form`, `modifier_ignored`. No amount of ranking, embedding, or
hybrid fusion reaches them, and the best conceivable selector between the two paths stops at 73.3%.

## What this settles

1. **Do not make semantic primary.** It is not better, and it cannot be gated.
2. **Do keep it, scoped to the tail**, where it beats lexical 50.7% vs 37.3% — but as a
   *candidate generator* feeding a re-ranker, not as an answer.
3. **Retrieval tuning is capped near 73%.** Fixing ranking is still the cheapest first move
   (38% of lexical failures had a better row already in the top 5, and the null-calorie
   hard-filter is nearly free), but it cannot be the whole plan.
4. **Past that ceiling the work is a curated canonical layer** — and that is the same
   structure gram conversion needs (see Part 3), so it is one build, not two.

---

# Part 3 — Gram conversion (the larger half)

Two defects here are cheap to fix and worth more than any matching change.

## The density table cannot fire for the units recipes use

`global_conversions` holds 88 real densities — **all keyed to `milliliter`**:

    water 1.00 g/ml · milk 1.03 · oil 0.92 · butter 0.91 · honey 1.42 · sugar 0.85

Recipes overwhelmingly do not use millilitres:

    tablespoon 2,441 · cup 2,316 · teaspoon 2,222 · millilitre 518 · fluid ounce 441

`quantityToGrams` requires an exact unit match (`normUnit(r.fromUnit) !== u → continue`) and
explicitly does not chain through a second rule. So **6,979 cup/tbsp/tsp occurrences bypass the
density table entirely** and fall to water-equivalent — while the correct density sits in the
table, unusable, because it is expressed per-millilitre. Normalizing any volume unit to ml and
then applying the per-ml density is a small, local change to `quantityToGrams`.

## `piece` is the most common unit in the library and resolves to nothing

3,759 occurrences (22% of MEASURED). 2,917 of them produce no grams at all, because:
- `global_conversions` has **13** `piece` rules,
- `custom_grams_per_unit` is populated on **0 of 83** mappings,
- only **213 of 37,007** USDA generic portion entries use a countable unit (0.6%),
- and **all 5,432 Survey (FNDDS) foods carry numeric USDA measure-unit codes** instead of
  labels (`"90000"`, `"10205"` — 1,134 distinct codes over 22,193 entries). `load-usda-foods.ts`
  reads `p.modifier` first, which for FNDDS is that code; the human label is in
  `portionDescription`. Recoverable by fixing the precedence and re-running the loader
  (`load-all-usda.sh` re-downloads the dumps; they are not retained locally).

The `piece` problem is highly concentrated — **the top 100 names cover 55% of it**, and they are
all staples: garlic cloves (304), garlic (113), yellow onion (98), large eggs (84), scallions (67),
bay leaves (54), lemon (50), carrots (34). Note that `garlic cloves` / `garlic` / `garlic clove` /
`garlic cloves, minced` / `medium garlic cloves` are five keys for one weight — another argument
for keying the canonical layer on a *normalized* term rather than the raw string.

## Modelled impact (same harness, full corpus)

| scenario | fully resolved | water-density guess | no grams |
|---|---:|---:|---:|
| today | 32.4% | 31.1% | 16.1% |
| + volume→ml chaining | **43.1%** | 20.4% | 16.1% |
| + piece-weight table (top 150) | **51.4%** | 20.4% | 7.6% |

**32.4% → 51.4% using no new data sources** — the densities already exist, and the piece table is
~150 curated rows. The residual 14.7% VAGUE (no quantity in the recipe at all) is a UI question,
not a data one.

---

# Part 4 — Correction: the path production actually uses

Parts 1–2 measured the wrong ranker. `useRecipeNutrition` resolves in this order:

    1. user / platform mapping   (ingredient_nutrition_mappings, exact string)
    2. searchLocalEssentials()   <-- local SQLite, answers ~97% of the time
    3. searchNutrition()         <-- the edge function + server RPC, only if (2) returns 0 rows

So `search_nutrition_foods` — the thing Parts 1–2 replayed, and the thing the v2 migration
carefully tuned — is the **fallback**. The live matcher is `searchLocalEssentials` in
`apps/web/src/nutrition/localCache.ts`, and it is a different algorithm:

| | server `search_nutrition_foods` | local `searchLocalEssentials` |
|---|---|---|
| corpus | 13,588 generic (incl. 5,432 FNDDS) | **8,156** — Foundation + SR Legacy only |
| matching | tsvector lexemes | **`search_blob LIKE '%term%'` — infix substring** |
| first sort key | full-coverage | **data_type tier** |
| coverage rank | 1st | 3rd |

The two agree on only 17.5% of names; **they disagree on 80.6% of occurrences.**

## Why tier-first is fatal

Foundation is 363 rows and always sorts first, so a Foundation row containing *one* query
token beats an SR Legacy row containing *all* of them. Combined with substring matching
(`'%pure%'` matches "puree", `'%honey%'` matches "honeydew", `'%bay%'` matches "Bay, Patagonian"):

    147x  ground black pepper         -> Turkey, ground, 93% lean, pan-broiled crumbles
     96x  diamond crystal kosher salt -> Pickles, cucumber, dill or kosher dill
     85x  ground turmeric             -> Turkey, ground, 93% lean      (also cardamom, saffron)
     89x  honey                       -> Melons, honeydew, raw
     80x  fresh ginger                -> Corn, sweet, ... fresh, raw   (also fresh cilantro)
     54x  bay leaves                  -> Scallops, bay, Patagonian, frozen
     46x  white sugar                 -> Egg, white, dried
     31x  pure vanilla extract        -> Tomato, puree, canned

Graders independently flagged the systemic clusters: every fresh herb collapsing onto
"Corn, sweet, fresh, raw" (no calories), every citrus juice onto "Grapefruit juice", every
bare water onto "Ham, sliced, water added".

## Full-corpus measurement on the real path

| | distinct | occurrence-weighted |
|---|---:|---:|
| platform mapping saves it | 78 (1.3%) | **28.6%** |
| served by the local substring ranker | 5,699 (93.7%) | 68.7% |
| → pick does not contain the head noun | 2,694 (44.3%) | **29.5%** |
| → NULL calories | 1,107 (18.2%) | **12.6%** |
| no local hit, falls to the edge function | 305 (5.0%) | 2.7% |

Null-calorie picks are **12.6% occurrence-weighted vs 4.5% on the server path** — ~3× worse.

## Graded baseline (same 300 items, same rubric, six fresh graders)

> ### **True current system: 31.3% usable — 54.0% occurrence-weighted.**

| path | share of sample | usable | occ-weighted |
|---|---:|---:|---:|
| **platform mapping** (78 curated rows) | 56 | **91.1%** | 80.4% |
| **local substring ranker** | 232 | **18.5%** | 15.8% |
| falls through to edge | 12 | 0.0% | 0.0% |
| head / tail | | 44.0% / **18.7%** | 55.0% / 19.6% |

Failure modes: `head_noun_coincidence` 90, `null_calories_row_won` 42,
`term_extraction_dropped_signal` 14, `modifier_ignored` 13. **35% of bad matches had a better
row already in the local candidate list** — ranking, not retrieval.

## What this changes about the design

The single most important fact in this audit is the contrast between **91.1%** and **18.5%**.

Essentially all of the system's working behaviour comes from 78 hand-curated rows covering
28.6% of occurrences. Everything else runs through a substring matcher that is right 18.5%
of the time. That is not a ranker to tune — it is a placeholder to replace.

It also settles the Part 2 question more firmly than Part 2 could: semantic scored 62.3% on
the same items, and the *server* lexical path 55.7–66%. Both are far above the 18.5% that
production actually serves. So there is real headroom from retrieval work — but the curated
layer is worth more than either, and it is the same structure the gram fixes need.
