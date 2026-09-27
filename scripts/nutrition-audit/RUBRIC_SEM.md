# Grading rubric — SEMANTIC nutrition matching (vector search)

Same task and same verdict scale as the lexical audit, so the numbers are comparable.
You are judging a *semantic* (embedding cosine) matcher that maps a recipe ingredient
string to a USDA food row whose per-100g facts drive a recipe nutrition panel.

Each item shows TWO variants of the same matcher:
- **SEMANTIC-A** — the query is the *cleaned* term string.
- **SEMANTIC-B** — the query is the *raw* ingredient string.
They are often identical; where they differ, that difference is the point of the test.

## Verdict scale (one per variant, per item)
- `CORRECT`      — best available choice; numbers would be right.
- `ACCEPTABLE`   — different row than ideal but nutritionally equivalent within ~10%
                   on calories and macros.
- `WRONG_VARIANT`— right food, wrong form, materially different numbers (raw vs cooked,
                   whole vs skim, dried vs fresh, with-salt vs without).
- `WRONG_FOOD`   — a different food entirely.
- `UNUSABLE`     — the pick has NO CALORIE DATA. (Always UNUSABLE, even if the food is right.)

## Per item also record
- `better_in_runners`: `"A"`, `"B"`, or `null` — was a strictly better row visible in that
  variant's runners-up list than the one picked?
- `failure_mode_a` / `failure_mode_b`: null when CORRECT/ACCEPTABLE, else ONE short
  snake_case tag. Suggested: `phonetic_or_spelling_confusion` (e.g. kosher->kohlrabi),
  `null_calories_row_won`, `topically_related_not_the_food` (a dish containing the
  ingredient rather than the ingredient), `wrong_form`, `overspecific_row`,
  `too_generic_row`, `brand_house_row`, `compound_ingredient`, `corpus_missing_food`.
- `note`: one short clause. Terse.

## Judging guidance
- USDA generic descriptions are head-first: "Oil, olive", "Salt, table".
- A recipe calling for an ingredient wants THE INGREDIENT, not a cooked dish that
  contains it. "Kohlrabi, cooked, boiled, drained, with salt" is NOT salt.
- `cos=` is the cosine similarity. Note in your summary whether it looked like a usable
  confidence signal (i.e. do wrong picks actually have lower cosine than right ones?) —
  this decides whether a similarity floor would help.
- Do not be generous. This exists to find defects.

## Output
Write ONLY a JSON array to the output file, one object per item, in order:
`{"idx":0,"verdict_a":"...","verdict_b":"...","better_in_runners":null,
  "failure_mode_a":null,"failure_mode_b":null,"note":"..."}`
No prose, no markdown fence, in that file. Then reply with a 6-line summary:
verdict counts for A, verdict counts for B, whether A or B was better overall,
the 3 most common failure modes, and your read on whether cosine is a usable
confidence threshold.
