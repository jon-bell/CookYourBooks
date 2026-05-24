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

export const TOC_PROMPT = `This image is a cookbook table of contents (or index). Extract every visible entry and return JSON ONLY in this exact shape:

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
