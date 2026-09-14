# Nutrition matching + gram conversion — overhaul design

Companion to `NUTRITION_AUDIT.md`. Every number below is measured on prod, not estimated;
the harness that produced them is `scripts/nutrition-audit/` and is also the acceptance gate.

## Baseline (measured, not assumed)

| | value |
|---|---|
| match quality, graded | **31.3% usable** (54.0% occurrence-weighted) |
| — via the 78 curated mappings | **91.1%** usable, covering 28.6% of occurrences |
| — via the local substring ranker | **18.5%** usable, covering 68.7% of occurrences |
| end-to-end (usable food **and** trustworthy grams) | **32.4%** of occurrences |

The design follows from one contrast: **91.1% vs 18.5%**. The curated path works; the
generic path does not. So the plan is to grow the curated path to cover most real usage,
fix the generic path to be a respectable backstop rather than the primary answer, and fix
gram conversion, which is independently broken and is the larger half of the error.

**Design rule throughout:** never silently substitute a wrong number for a missing one. A
null-calorie row and an unconvertible quantity must both surface as "not counted", never as
an implicit zero folded into the total.

---

## Stage 0 — Ranking and extraction fixes

Cheap, local, and independently valuable. **35% of bad matches already had a better row in
the candidate list**, so this is recoverable without new data.

### 0.1 Both rankers must agree, and the local one is authoritative
Today `searchLocalEssentials` (SQLite) and `search_nutrition_foods` (Postgres) implement
different algorithms and disagree on 80.6% of occurrences. Fix the local one to the server's
*semantics*, then keep them in lockstep the way `snapshotCodec.ts` and `_ingredientTerms.ts`
already are — a shared spec plus a test that is the contract.

Concretely, in `apps/web/src/nutrition/localCache.ts`:

- **Token-boundary matching, not infix substring.** `LIKE '%pure%'` matching "puree" (and
  `honey`→honeydew, `bay`→"Bay, Patagonian") causes the single largest failure class,
  `head_noun_coincidence` (90 of 206). Store the blob space-padded and match `'% term %'`,
  with a short suffix set for plurals. This alone kills the turkey/pickles/honeydew family.
- **Coverage first, tier last.** Tier is currently the *first* sort key, so a 363-row
  Foundation table always wins; a Foundation row matching one token beats an SR Legacy row
  matching all of them. Invert to match the server's deliberate ordering (its migration
  comment already explains why tier must be late).
- **Hard-filter `calories_kcal is null`.** Not a sort key — a filter. 73.8% of Foundation
  rows have no calories, and they currently win 12.6% of occurrences and silently zero them.
  If filtering empties the result, return no match and say so.
- **Require the head noun.** Promote rows whose pre-comma head phrase stem-matches the query
  head. This is what separates `Water, tap` from `Water Chesnut`, where every other signal
  ties and the winner is decided by arbitrary `source_id` order.
- **Sync FNDDS too, or stop pretending.** The local mirror holds Foundation + SR Legacy only;
  FNDDS's 5,432 foods are server-only, so 305 names have no local candidate at all. Either
  include them (~5k rows, the mirror is already ~8k) or make the fall-through explicit.

### 0.2 `extractIngredientTerms` fixes
Shared by both rankers and by the canonical key, so these land first.

- **NFD-normalize before the ASCII strip.** `jalapeño`→`jalape`, `crème fraîche`→`cr me fra che`,
  `pâté`→`""`. 99 names / 134 occurrences currently destroyed.
- **Don't drop a part/container word when it is the only thing left.** `lemongrass stalks`,
  `cinnamon stick`, `lemon zest`, `basil leaves`, `lime wedges` lose their head noun to the
  size/quantity drop-list and match on the modifier instead.
- **Keep the shared noun in "X or Y" lists.** `green or brown lentils` → `green`;
  `cherry or grape tomatoes` → `cherry`. The trailing noun is the food.
- **Flag compound strings** (`salt and pepper`, `kosher salt and ground black pepper`) rather
  than matching one of them. Emit two ingredient matches or none — 6 cases in the sample.

---

## Stage 1 — Canonical ingredient layer

The core of the overhaul, and the structure Stage 2 also needs.

### Why this shape
Normalizing the corpus collapses **6,087 raw names → 4,227 keys (1.44×)**, and coverage is
steep:

| curated keys | share of all occurrences |
|---:|---:|
| 100 | 47.3% |
| 250 | 61.9% |
| **500** | **71.7%** |
| 1,000 | 80.8% |

At the curated path's measured 91.1% quality, **500 rows covers 71.7% of real usage**. The
existing 78 rows cover 28.6% — so this is the same mechanism that already works, sized
properly, and keyed so it stops being brittle.

### Schema

```sql
-- The fact holder. One row per distinct cooking ingredient.
create table public.canonical_ingredients (
  key            text primary key,            -- canonicalIngredientKey(), NOT the raw string
  display_name   text not null,
  source         text,                        -- 'USDA_FDC' | 'OPEN_FOOD_FACTS' | null
  source_id      text,                        -- null = deliberately "no good match"
  density_g_per_ml numeric,                   -- volume -> mass  (Stage 2)
  piece_grams    numeric,                     -- 'piece' -> mass (Stage 2)
  piece_label    text,                        -- 'clove', 'medium onion' — for the UI
  review_state   text not null default 'proposed'
                 check (review_state in ('proposed','reviewed','rejected')),
  provenance     jsonb not null default '{}'::jsonb,  -- model, prompt ver, candidates seen
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Every lookup goes through here, including the identity alias.
create table public.canonical_ingredient_aliases (
  alias_key     text primary key,
  canonical_key text not null references public.canonical_ingredients(key) on delete cascade
);
```

Both are public-readable reference data, service-role write — same posture as
`nutrition_foods_master`. `updated_at` gets the standard trigger.

### `canonicalIngredientKey()`
New export in `packages/domain/src/services/ingredientTerms.ts`, built on the *fixed*
extractor: cleaned terms, order preserved (English is head-final and USDA is head-first, so
order carries signal), joined by single spaces. Deterministic, and — like
`extractIngredientTerms` — it must be byte-identical in the edge-function copy. **The
round-trip test is the contract.** It replaces `ingredientLookupKey`'s raw
lowercase-and-trim, which is why `extra-virgin olive oil` and `extra virgin olive oil`
currently resolve to different foods.

### Local-first
The layer is reference data of a few thousand rows, so it mirrors to SQLite exactly like
`nutrition_foods_essentials`: new local tables, a new pull topic alongside
`pullNutritionEssentials`, `SCHEMA_VERSION` 8 → 9. Lookup is then offline and
sub-millisecond, which is what lets it sit *ahead* of the substring ranker.

### New resolution order
```
1. user mapping                      (unchanged — the user's explicit choice always wins)
2. canonical layer  (normalized key, local)          <-- new, and the main path
3. local essentials, Stage-0 ranker  (local)
4. edge fn: lexical ∪ semantic candidates, re-ranked  (Stage 3)
5. Open Food Facts
```
`ingredient_nutrition_mappings` keeps its per-user rows and loses its platform rows, which
migrate into `canonical_ingredients` as `review_state='reviewed'` — they are hand-curated
and measured at 91.1%, so they seed the table rather than being thrown away.

### Seeding — LLM-assisted, human-reviewed
Mirrors the existing `scripts/nutrition-seed-reviewed.tsv` workflow.

`scripts/seed-canonical-ingredients.ts`:
1. Rank normalized keys by real occurrence (the audit harness already produces this).
2. For each, gather candidates from **both** retrieval paths — the audit showed the oracle
   union (73.3%) beats either alone, and they fail differently.
3. Ask the model to pick a `source_id` **or return none**, and to emit `density_g_per_ml`,
   `piece_grams` + `piece_label`, and proposed aliases — with its reasoning captured into
   `provenance`.
4. Write a review TSV. Reviewed rows land as `review_state='reviewed'`; unreviewed stay
   `'proposed'`.

Metering: add a `canonical_seed` feature to `misc_llm_usage` (widen the
`misc_llm_usage_feature_check` constraint and the RPC's inline guard — both enumerate the
list, per `20260626000200`) so the seeding run shows up in `/cost` like every other LLM call.

**Only `review_state='reviewed'` rows are served.** `'proposed'` rows are visible to the
review tooling and to nobody else — an unreviewed LLM guess must never silently become a
user's nutrition number.

### Closing the loop
`suggestion_events` already records `nutrition_match` accept/correct/clear with the full
candidate set. A correction against a canonical row is precisely a review signal, so a
periodic report of "canonical rows users keep overriding" becomes the re-review queue. No
new capture surface, so no privacy-policy change — but if that ever changes,
`apps/web/src/legal/content.ts` needs updating in the same PR.

---

## Stage 2 — Gram conversion

Independently broken, and larger than the matching error: 31.1% of occurrences are currently
water-density guesses and 16.1% get no grams at all.

### 2.1 Chain volume units through millilitres
`global_conversions` holds 88 real densities (oil 0.92, honey 1.42, sugar 0.85) — **all keyed
to `milliliter`**. Recipes use tablespoon (2,441), cup (2,316), teaspoon (2,222); millilitre
is 518. `quantityToGrams` requires an exact unit match and explicitly does not chain, so
**6,979 occurrences bypass the correct density sitting right there** and fall to water
density — a ~2× error on flour, the most common baking ingredient.

Fix: in `quantityToGrams`, when the unit is a known volume unit, convert to ml via
`VOLUME_TO_ML` and apply the best matching per-ml density rule. Keep the existing
most-specific-rule selection; keep `approximate: false` for a real density and reserve the
water-equivalent path (and its UI caveat) for genuinely unknown ingredients.

**Measured: 32.4% → 43.1% end-to-end, using data already in the database.**

### 2.2 Piece weights
`piece` is the most common unit in the library (3,759 occ, 22% of MEASURED); 2,917 produce
no grams. USDA cannot help — only 213 of 37,007 generic portion entries use a countable unit
(0.6%), and garlic's sole portion is `{"unit":"racc","grams":85}` (RACC, not a ~3 g clove).

Fix: `canonical_ingredients.piece_grams`, seeded in Stage 1. The problem is concentrated —
**the top 100 names cover 55%** — and they are staples: garlic cloves (304), garlic (113),
yellow onion (98), large eggs (84), scallions (67), bay leaves (54), lemon (50). Note
`garlic cloves` / `garlic clove` / `garlic cloves, minced` / `medium garlic cloves` are five
raw strings and one canonical key — which is exactly why the key must be normalized.

**Measured: 43.1% → 51.4% with a ~150-row piece table.**

### 2.3 Recover the FNDDS portion labels
All 5,432 Survey (FNDDS) foods carry numeric USDA measure-unit codes instead of labels
(`"90000"`, `"10205"` — 1,134 distinct codes over 22,193 entries), so 40% of the generic
corpus has unusable portion data. Cause: `portionsFromUsda` in `scripts/load-usda-foods.ts`
reads `p.modifier` first, which for FNDDS is that code; the human label is in
`portionDescription`.

Fix: when `modifier` is purely numeric, prefer `portionDescription`. Re-run
`scripts/load-all-usda.sh` (it re-downloads the dumps — they are not retained locally).
Verify the hypothesis on one FNDDS food before the full reload.

### 2.4 Honest reporting of what didn't convert
14.7% of occurrences are VAGUE with no quantity at all ("salt to taste"). That is not a bug
to fix in the data — `RecipeNutritionPanel` should keep saying "based on N of M ingredients"
and name the ones it skipped.

---

## Stage 3 — Retrieval as candidate generation

Only after Stages 0–2, and scoped by what Part 2 proved.

The audit measured a hard ceiling: the **oracle union of lexical and semantic, with a perfect
selector, is 73.3%**, and **70% of remaining failures are reachable by neither path**. It also
proved there is no selector to build — cosine does not separate right from wrong (correct
median 0.9534 vs wrong 0.9344; 41 of 47 wrong picks score >0.90; wrong picks reach 1.0).

So:
- **Do not make semantic primary, and do not add a similarity floor.** There is no threshold.
- **Do keep semantic scoped to the tail**, where it beats lexical 50.7% vs 37.3%, as a
  *candidate generator* feeding the Stage-0 re-ranker — never as the answer.
- The one place a cosine floor helps is detecting *corpus gaps*: below ~0.82 the graders
  consistently saw "USDA doesn't have this food" (`sabzi khordan`, `lavash`, `wondra`). Use
  it to route to Open Food Facts and to flag the key for canonical review — not to gate.

---

## Validation protocol

Identical to the audit, which is what makes before/after comparable.

1. `scripts/nutrition-audit/` re-run end to end. The sample is **seeded (PRNG 1337)**, so it
   re-selects the **same 300 ingredients**.
2. Re-copy `terms.ts` from the edge-function extractor first — otherwise the replay measures
   the old behaviour.
3. Six independent graders, blind, `RUBRIC.md` unchanged.
4. Report the **bound**, never the point estimate, wherever a path's output is unobservable
   (`honest.mjs`). Part 1 got this wrong by measuring the server RPC while production ran the
   local one — so the re-run must replay **`searchLocalEssentials` semantics**, via
   `localsql.mjs`, as the primary path.
5. Objective full-corpus metrics alongside the grades, which need no graders and cannot drift:
   `metrics.mjs` (head-noun-present %, null-calorie %, no-hit %) and `grams.mjs` /
   `grams3.mjs` (end-to-end resolution).

### Acceptance gates

| metric | baseline | gate |
|---|---:|---:|
| graded usable, occurrence-weighted | 54.0% | **≥ 80%** |
| graded usable, by distinct name | 31.3% | ≥ 60% |
| tail-stratum usable | 18.7% | ≥ 45% |
| null-calorie picks (occ-weighted) | 12.6% | **0%** (hard filter) |
| pick missing the head noun (occ-weighted) | 29.5% | ≤ 8% |
| end-to-end resolved (food **and** grams) | 32.4% | **≥ 60%** |

The 80% occurrence-weighted target is the one projection here, so its arithmetic is explicit:
canonical covering 71.7% of occurrences at the curated path's measured 91.1% contributes
~65%; the remaining 28.3% via Stage-0 retrieval at roughly the server path's ~55% contributes
~16%. If the curated rows land below 91.1% in review, this target moves — it is a forecast
from two measured quantities, not a promise.

---

## Sequencing and risk

| stage | depends on | risk |
|---|---|---|
| 0.2 extractor fixes | — | changes the canonical key, so it **must** land before any seeding |
| 0.1 ranker fixes | 0.2 | low; pure ranking, measurable immediately |
| 2.1 volume chaining | — | low, isolated to `quantityToGrams`, +10.7pp on its own |
| 2.3 FNDDS reload | — | independent; verify on one food before a full reload |
| 1 canonical layer | 0.2 | the large one; LLM cost + review effort scale with row count |
| 2.2 piece weights | 1 | rides the same seeding pass |
| 3 candidate re-rank | 0.1, 1 | lowest value per the ceiling measurement; do last |

**Start with 0.2 → 0.1 → 2.1.** Those are small, independently verifiable, and together should
move the baseline materially before any LLM spend. Re-run the harness after that group to get
a clean read on how much headroom the canonical layer actually has to cover.

Two things to watch:
- **Key drift.** Any later change to `extractIngredientTerms` silently rekeys the canonical
  table. Store the key-function version in `provenance` and fail the build if the domain copy
  and the edge copy disagree.
- **Scope.** Stage 1 is where this could sprawl. 500 reviewed rows hits 71.7% of occurrences;
  3,000 would hit 93.8% at six times the review cost. Ship 500, measure, then decide.

---

# Validation results (2026-09-14)

Stages 0, 2.1 and 2.3 implemented on `feat/nutrition-matching-overhaul` and re-measured with
the same harness, the same seeded 300 ingredients, the same rubric, and six fresh blind
graders. Matching is replayed against **prod** data; unit/E2E run against local Supabase.

## Graded match quality

| slice | before | after |
|---|---:|---:|
| **all 300, occurrence-weighted** | 54.0% | **88.1%** |
| all 300, by distinct name | 31.3% | **67.7%** |
| head (150 most common) | 44.0% | **80.0%** |
| **tail (150 long-tail)** | 18.7% | **55.3%** |

By path, after:

| path | n | usable | occ-weighted |
|---|---:|---:|---:|
| platform mapping | 52 | 98.1% | 99.1% |
| local ranker | 234 | 65.0% | 80.4% |
| falls through to edge | 10 | 0% | 0% |
| declined (compound) | 4 | 0% | 0% |

**113 items improved (3,133 occurrences); 4 regressed (53 occurrences).** The regressions were
all one failure mode — a head noun that also names a beverage or confection: `ginger` → ginger
tea (38), `cinnamon` → cinnamon bread (8), `channeled lime twist` (6), `lime wheels` (1).

The `ginger` case, the largest of the four, is fixed by a `fresh`↔`raw` synonym in the
matcher's whole-word probe: USDA writes "raw" where recipes write "fresh". Measured over the
full prod corpus that pair changes 72 ingredient names and improves every one of them —
`fresh ginger` "Tea, ginger" → *Ginger root, raw*, `fresh spinach` "Spinach, fresh, cooked
with oil" → *Spinach, raw*, `diced fresh tomatoes` "Tomatoes, fresh, cooked" → *Tomatoes,
raw*. The graded numbers above predate it, so they understate the result slightly.

## Objective full-corpus metrics (no graders involved)

| metric | before | after | gate |
|---|---:|---:|---:|
| pick missing the head noun (occ-wtd) | 30.3% | **4.8%** | ≤ 8% ✓ |
| null-calorie pick (occ-wtd) | 12.6% | **0.0%** | 0% ✓ |
| no local candidate (occ-wtd) | 2.7% | 2.8% | — |
| end-to-end resolved (food **and** grams) | 26.4% | **46.7%** | ≥ 60% ✗ |
| — of which food had no usable facts | 12.8% | **1.6%** | — |

Note the end-to-end baseline is **26.4%, not the 32.4%** in `NUTRITION_AUDIT.md` Part 1: that
figure was computed with server-path matches, and per Part 4 the local path is what production
runs. 26.4% is the correct like-for-like baseline.

## Gates

| gate | target | result |
|---|---:|---|
| graded usable, occurrence-weighted | ≥ 80% | **88.1%** ✓ |
| graded usable, by distinct name | ≥ 60% | **67.7%** ✓ |
| tail usable | ≥ 45% | **55.3%** ✓ |
| null-calorie picks | 0% | **0%** ✓ |
| head noun missing | ≤ 8% | **4.8%** ✓ |
| end-to-end resolved | ≥ 60% | **46.7%** ✗ |

**The end-to-end gate is not met, and cannot be by this PR.** It is gated on `piece` weights
(Stage 2.2), which come from the canonical layer's seeding pass (Stage 1) — `piece` is 22% of
measured ingredients and still resolves to no grams. Modelled, a ~150-row piece table takes
end-to-end to ~55–60%. Everything else in the gate list is met or exceeded.

## What is NOT in this PR

- **Stage 1, the canonical ingredient layer.** Schema, seeding script and review flow. The
  seeding pass spends real money against the user's LLM key and needs a human review pass, so
  it belongs in its own change rather than being half-landed here.
- **Stage 2.2, piece weights** — rides on that seeding pass.
- **Stage 3, candidate re-ranking** — lowest value per the measured 73.3% retrieval ceiling.
- **Stage 2.3 is code-only here.** `portionsFromUsda` now prefers `portionDescription` when
  `modifier` is a bare FNDDS code, but the fix only takes effect after re-running
  `scripts/load-all-usda.sh`, which re-downloads the USDA dumps and rewrites
  `nutrition_foods_master`. Verify the hypothesis on one FNDDS food before the full reload.

## Known residual defects

- `cinnamon` → cinnamon bread. The chosen ordering (coverage,
  penalised for description length, above the head-prefix signal) was picked because the
  alternative — head-prefix first — sends `ground black pepper` to "Pepper steak", `ground
  cinnamon` to "Cinnamon buns" and every citrus juice to "apple and grape blend". Measured over
  the 40 most frequent ingredients, that trade is 892 occurrences to 158 in favour of the
  ordering shipped here. Both cases are top-500 keys, so the canonical layer fixes them.
- Plain `flour` finds no generic wheat-flour row — a real corpus/retrieval gap several graders
  flagged independently.
- 10 of 300 still fall through to the edge function and are unobservable to graders; they are
  scored 0% here, so the 88.1% is a floor, not a point estimate.
