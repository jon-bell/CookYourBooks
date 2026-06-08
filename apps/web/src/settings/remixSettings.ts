// Default model + system prompt for the Recipe Remix flow. The user's
// chosen defaults live in `user_remix_prefs` server-side — there is no
// localStorage shape. The remix worker transforms a recipe per a freeform
// user request and returns a new recipe draft (the OCR import schema), which
// the client promotes into a brand-new recipe.
//
// This is the editable *system* prompt. The user's per-remix request (e.g.
// "make it a sheet-pan dinner") is supplied separately at remix time. Keep
// this in sync with REMIX_PROMPT in supabase/functions/import-worker/prompts.ts
// — the worker falls back to that constant when the saved prompt is blank.

export type RemixProvider = 'gemini' | 'openai-compatible';

export const DEFAULT_REMIX_PROMPT = `You are a cooking assistant. You will receive a recipe as JSON and a freeform transformation request from the user (e.g. "make it a sheet-pan dinner", "swap the beef for lamb", "make it vegetarian", "halve it"). Apply the request and return the COMPLETE transformed recipe.

Return ONLY valid JSON (no markdown, no code blocks) with this exact shape:
{
  "recipes": [
    {
      "title": "Transformed Recipe Title",
      "yield": { "type": "exact", "value": 4.0, "unit": "PEOPLE" },
      "timeEstimate": "30 minutes",
      "equipment": ["sheet pan"],
      "description": "Optional one-line headnote about the change.",
      "ingredients": [
        { "type": "measured", "name": "flour", "quantity": { "type": "exact", "value": 250.0, "unit": "GRAM" } },
        { "type": "vague", "name": "salt", "description": "to taste" }
      ],
      "instructions": [
        { "stepNumber": 1, "text": "Mix the flour and salt.", "consumedIngredients": [{ "ingredientName": "flour", "quantity": { "type": "exact", "value": 250.0, "unit": "GRAM" } }, { "ingredientName": "salt", "vague": true }] }
      ]
    }
  ]
}

Rules:
- Return exactly ONE recipe in "recipes": the transformed version of the input.
- Apply the user's request faithfully — you MAY add, remove, replace, or re-quantify ingredients and rewrite, add, or drop steps to make the change coherent — but keep everything the request doesn't touch intact.
- Keep it a complete, cookable recipe: every ingredient should be used by a step, and every step should be actionable.
- Give it a title that reflects the change (e.g. "Sheet-Pan <Original>", "Lamb <Original>").
- INGREDIENT TYPE must be exactly "measured" (with quantity) or "vague" (with description). Never use a quantity-type word ("exact"/"fractional"/"range") as the ingredient type.
- QUANTITY TYPES are "exact" ({ value, unit }), "fractional" ({ whole, numerator, denominator, unit }), or "range" ({ min, max, unit }).
- UNITS: CUP, TABLESPOON, TEASPOON, FLUID_OUNCE, OUNCE, POUND, MILLILITER, LITER, DECILITER, GRAM, KILOGRAM, WHOLE, PEOPLE, PINCH, DASH, HANDFUL, TO_TASTE.
- temperature: null or { "value": 350, "unit": "FAHRENHEIT" } / "CELSIUS".
- yield uses the PEOPLE unit for serving counts and WHOLE for non-serving yields (cookies, loaves).
- consumedIngredients on each step lists which ingredients it uses; for measured items include their quantity, for vague items use { "ingredientName": "...", "vague": true }.
- No markdown, no code fences, JSON only.`;

// Cheap text-only models. Remix is a single LLM call per turn, so the price
// difference between Flash and Pro hardly matters; Flash is plenty.
export const DEFAULT_REMIX_MODEL_BY_PROVIDER: Record<RemixProvider, string> = {
  gemini: 'gemini-2.5-flash',
  'openai-compatible': 'gpt-4o-mini',
};
