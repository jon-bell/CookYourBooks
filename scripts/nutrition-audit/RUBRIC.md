# Grading rubric — nutrition ingredient→USDA food matching

You are auditing an automatic matcher that maps a recipe ingredient string
to a USDA FoodData Central food row, whose per-100g nutrition facts are then
used to compute the recipe's nutrition panel. Judge each match on whether it
produces **nutritionally correct numbers for that ingredient as used in cooking**.

## Verdict (exactly one per item)
- `CORRECT`      — best available choice; numbers would be right.
- `ACCEPTABLE`   — different row than ideal, but nutritionally equivalent
                   within ~10% on calories and macros (e.g. "Salt, table" vs
                   "Salt, table, iodized"; two 884-kcal oils).
- `WRONG_VARIANT`— right food, wrong form, and it materially changes the
                   numbers (raw vs cooked pasta/rice/beans; whole vs skim
                   milk; dried vs fresh herbs; with-salt vs without).
- `WRONG_FOOD`   — a different food entirely (token coincidence, e.g.
                   "kosher salt" → "Almonds, salted").
- `UNUSABLE`     — matched row has NO CALORIE DATA, or there is no match at
                   all. These silently zero out the panel.

## Also record, per item
- `better_in_top5`: source_id of a strictly better candidate that WAS present
  in the shown top-5 but ranked below the pick — or null. (This separates a
  RANKING failure from a RETRIEVAL/CORPUS failure.)
- `failure_mode`: null when CORRECT/ACCEPTABLE, else ONE short snake_case tag.
  Reuse these tags where they fit; invent one only if none apply:
  `null_calories_row_won`, `head_noun_coincidence`, `raw_vs_cooked`,
  `dried_vs_fresh`, `overspecific_row`, `too_generic_row`, `brand_house_row`,
  `wrong_species_or_cut`, `modifier_ignored`, `term_extraction_dropped_signal`,
  `term_extraction_kept_noise`, `no_lexical_hit`, `corpus_missing_food`,
  `compound_ingredient` (e.g. "salt and pepper" — two foods in one string).
- `note`: one short clause of justification. Be terse.

## Important judging guidance
- USDA generic descriptions are head-first: "Oil, olive", "Salt, table".
- A `NO CALORIE DATA` pick is ALWAYS `UNUSABLE`, even if the food is right.
- `match path = semantic_fallback` means lexical produced nothing usable and
  the system falls through to a semantic search whose result is NOT shown to
  you. Grade these as `UNUSABLE` **only** on the basis that the shown lexical
  path failed, and set failure_mode `no_lexical_hit` (or a more specific term
  extraction tag if the cleaned query is visibly at fault). Note in `note`
  what the ideal USDA row would be, if you can name it.
- Judge the AUTO-MATCH line, not the candidate list.
- Do not be generous. This audit exists to find defects.

## Output
Write ONLY a JSON array to the output file, one object per item, in order:
`{"idx":0,"verdict":"...","better_in_top5":null,"failure_mode":null,"note":"..."}`
No prose, no markdown fence, in that file. Then reply with a 5-line summary:
verdict counts, and the 3 most common failure modes you saw.
