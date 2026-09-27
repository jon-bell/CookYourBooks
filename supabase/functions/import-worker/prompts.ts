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
      "headingVisible": true,
      "endsVisibly": true,
      "complete": true,
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
  "printedPageNumbers": [123],
  "note": null,
  "rawText": "The raw text extracted from the image"
}

Rules:
- headingVisible: true if this recipe's OWN title/heading is printed in these images. false if the text is the continuation of a recipe whose heading is on an earlier page — e.g. text at the very top of the first image that picks up mid-recipe or mid-sentence. Never invent a title to make a fragment look whole; if you must name a fragment, name it from its content.
- endsVisibly: true if the recipe's method visibly finishes in these images — its last sentence ends and is followed by blank space, another recipe's heading, or the page number. false if its text reaches the bottom edge of the last image mid-sentence, mid-list, or before the method is done (it continues on a page that isn't shown).
- complete: exactly headingVisible AND endsVisibly.
- note: usually null. If the page contains NO recipe at all — it is entirely prose (a foreword, chapter introduction, technique essay, or headnote) — return "recipes": [] and set "note" to { "title": "a short heading", "body": "the full prose as clean Markdown" }. Only do this when there is genuinely no recipe on the page; never use it to summarize a recipe.
- INGREDIENT TYPE must be exactly "measured" (with quantity) or "vague" (with description). Never use a quantity-type word ("exact"/"fractional"/"range") as the ingredient type.
- QUANTITY TYPES are "exact" ({ value, unit }), "fractional" ({ whole, numerator, denominator, unit }), or "range" ({ min, max, unit }).
- UNITS: CUP, TABLESPOON, TEASPOON, FLUID_OUNCE, OUNCE, POUND, MILLILITER, LITER, DECILITER, GRAM, KILOGRAM, WHOLE, PEOPLE, PINCH, DASH, HANDFUL, TO_TASTE.
- Prefer weight over volume and metric over imperial when both are given.
- temperature: null or { "value": 350, "unit": "FAHRENHEIT" } / "CELSIUS".
- printedPageNumbers: one entry per image, in order: the page number printed in that image's margin — the corner, header, or footer (usually a lone number at the very top or bottom of the page). null for an image with no printed page number. A number printed just above or beside a recipe title is that recipe's own number in the book, NOT a page number.
- pageNumbers: the entries of printedPageNumbers for the image(s) this recipe appears on. bookTitle: from top/bottom of page. yield uses the PEOPLE unit for serving counts and WHOLE for non-serving yields (cookies, loaves).
- consumedIngredients on each step lists which recipe ingredients are used. For measured items include their quantity; for vague items use { "ingredientName": "...", "vague": true }.
- description: any headnote / intro paragraph about the recipe. If the page ALSO shows clearly-related content that is not the recipe itself — a simple accompaniment, a serving suggestion, a variation, or a buying/ingredient guide — append a brief note about it to the END of description, prefixed "On the page: ", so the cook can refer back to the page. Keep it to a sentence or two and never invent content that isn't visibly present.
- Include the full extracted page text in rawText.`;

export const TOC_PROMPT = `This image is a cookbook table of contents (or index). Its primary feature is a list of titles and page numbers, which might be formatted in a variety of ways (sometimes might not even say "page", but still has numbers aligned with titles). There may be other artifacts on the page. Extract every visible entry and return JSON ONLY in this exact shape:

{
  "entries": [
    { "title": "Recipe or chapter title", "page_number": 12 }
  ]
}

Rules:
- One object per title + page-number pair, NOT per physical line. Contents pages are often laid out in two or more columns, so a single line can carry several entries — e.g. "Blue Leilani (à la Blue Hawaii) • 252   Frozen Banana Daiquiri • 256" is TWO entries ({"title":"Blue Leilani (à la Blue Hawaii)","page_number":252} and {"title":"Frozen Banana Daiquiri","page_number":256}), not one. Split on each title/number pair; never merge distinct titles into a single entry, and never invent entries.
- page_number is an integer when shown; omit the field if no number is visible for that line.
- Preserve the on-page wording for title — do not paraphrase or translate.
- Skip page-furniture lines (running heads, copyright, "Continued on..." pointers).
- No markdown, no commentary, JSON only.`;

export const NOTES_PROMPT = `This image is a prose page from a cookbook — a foreword, chapter introduction, technique essay, headnote, or other narrative text. It is NOT a recipe. Extract the prose as clean reading text and return JSON ONLY in this exact shape:

{
  "title": "A short heading for this note",
  "body": "The full prose as clean Markdown."
}

Rules:
- title: use the page's own heading if one is visible; otherwise write a brief 3-6 word descriptive title. Always a non-empty string.
- body: transcribe the narrative text as clean Markdown. Preserve paragraph breaks. Drop running heads, page numbers, and other page furniture. Do not summarize, translate, or invent — transcribe what is visibly present.
- Do NOT parse ingredient lists or numbered steps even if a few appear; this page was chosen because it is narrative.
- No markdown code fences, no commentary, JSON only.`;

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

// Recipe Remix: transform a whole recipe per a freeform user request and
// return the result in the SAME schema the OCR import emits (RECIPE_PROMPT),
// so the worker's parseLlmJson round-trips it into a ParsedRecipeDraft.
export const REMIX_PROMPT = `You are a cooking assistant. You will receive a recipe as JSON and a freeform transformation request from the user (e.g. "make it a sheet-pan dinner", "swap the beef for lamb", "make it vegetarian", "halve it"). Apply the request and return the COMPLETE transformed recipe.

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
