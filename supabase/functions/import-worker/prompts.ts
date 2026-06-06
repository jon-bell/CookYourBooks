// Recipe prompt is the "default rich" prompt from the browser-side OCR
// path (apps/web/src/settings/ocrSettings.ts DEFAULT_PROMPT). Kept
// verbatim so review-quality is identical to the photo-import flow.

export const RECIPE_PROMPT = `Extract recipe information from this image and return it as valid JSON (no markdown, no code blocks).

The image may contain one or more recipes. Extract all recipes you can identify.

IMPORTANT: Look carefully at the ENTIRE image, including:
- Top and bottom margins/headers (for book title and page numbers)
- Corners of the page (for page numbers)
- Text before or after the recipe (for background/description)
- Yield information (e.g., "serves 4", "makes 12 cookies", "yields 1 loaf")
- Special equipment mentioned (e.g., "stand mixer", "food processor", "baking sheet")

Return a JSON object with this structure:
{
  "recipes": [
    {
      "title": "Recipe Title",
      "pageNumbers": [123],
      "bookTitle": "Cookbook Name",
      "yield": { "type": "exact", "value": 4.0, "unit": "PEOPLE" },
      "timeEstimate": "30 minutes",
      "equipment": ["stand mixer"],
      "description": "Background text or description about the recipe",
      "ingredients": [
        { "type": "measured", "name": "flour", "quantity": { "type": "exact", "value": 250.0, "unit": "GRAM" } },
        { "type": "vague", "name": "salt", "description": "to taste" }
      ],
      "instructions": [
        { "stepNumber": 1, "text": "Mix the flour and salt.", "consumedIngredients": [{ "ingredientName": "flour", "quantity": { "type": "exact", "value": 250.0, "unit": "GRAM" } }, { "ingredientName": "salt", "vague": true }] }
      ]
    }
  ],
  "rawText": "The raw text extracted from the image"
}

Rules:
- INGREDIENT TYPE must be exactly "measured" (with quantity) or "vague" (with description). Never use a quantity-type word ("exact"/"fractional"/"range") as the ingredient type.
- QUANTITY TYPES are "exact" ({ value, unit }), "fractional" ({ whole, numerator, denominator, unit }), or "range" ({ min, max, unit }).
- UNITS: CUP, TABLESPOON, TEASPOON, FLUID_OUNCE, OUNCE, POUND, MILLILITER, LITER, DECILITER, GRAM, KILOGRAM, WHOLE, PEOPLE, PINCH, DASH, HANDFUL, TO_TASTE.
- Prefer weight over volume and metric over imperial when both are given.
- temperature: null or { "value": 350, "unit": "FAHRENHEIT" } / "CELSIUS".
- pageNumbers: array of integers from corners/headers. bookTitle: from top/bottom of page. yield uses the PEOPLE unit for serving counts and WHOLE for non-serving yields (cookies, loaves).
- consumedIngredients on each step lists which recipe ingredients are used. For measured items include their quantity; for vague items use { "ingredientName": "...", "vague": true }.
- Include the full extracted page text in rawText.`;

export const TOC_PROMPT = `This image is a cookbook table of contents (or index). Its primary feature is a list of titles and page numbers, which might be formatted in a variety of ways (sometimes might not even say "page", but still has numbers aligned with titles). There may be other artifacts on the page. Extract every visible entry and return JSON ONLY in this exact shape:

{
  "entries": [
    { "title": "Recipe or chapter title", "page_number": 12 }
  ]
}

Rules:
- One object per visible line; do not invent or merge entries.
- page_number is an integer when shown; omit the field if no number is visible for that line.
- Preserve the on-page wording for title — do not paraphrase or translate.
- Skip page-furniture lines (running heads, copyright, "Continued on..." pointers).
- No markdown, no commentary, JSON only.`;

// Default prompt for the instruction-rewrite worker. Used when the
// user hasn't set a custom prompt in user_rewrite_prefs. Mirrors the
// frontend default in apps/web/src/settings/rewriteSettings.ts so a
// brand-new user gets sensible output the first time they hit
// "Improve instructions".
export const REWRITE_PROMPT = `You are a cooking assistant. You will receive a JSON object describing a recipe's instructions. For each instruction, break compound sentences into atomic single-action steps suitable for hands-free Cook Mode display.

Return ONLY valid JSON (no markdown, no commentary) with this exact shape:

{
  "rewritten": [
    {
      "instructionId": "<echo the input id verbatim>",
      "simplifiedSteps": [
        { "text": "<one action>", "durationSec": <integer or null>, "temperature": { "value": <number>, "unit": "FAHRENHEIT" | "CELSIUS" } | null, "notes": "<short hint>" | null }
      ]
    }
  ]
}

Rules:
- One step per atomic action: one verb + one object, plus optional duration.
- If the source mentions a duration ("for 2 minutes", "about 30 seconds"), extract it as integer seconds in durationSec ("2 minutes" -> 120, "30 seconds" -> 30). If no duration is mentioned, omit the field or use null.
- If the source mentions a temperature ("over medium-high heat", "350F"), keep it on the relevant step.
- Echo each input instructionId verbatim so we can match results back to the source steps.
- Do not invent new instructions; only rephrase what is present.
- Do not include the original sentence as a step — only the atomic rewrites.
- No markdown, no code fences, JSON only.`;
