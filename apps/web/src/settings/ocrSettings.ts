// User preferences for the LLM-backed OCR import. Stored in localStorage
// so they're per-device (the API key is sensitive — we deliberately do NOT
// sync it through Supabase/cr-sqlite).

export type OcrProvider = 'gemini' | 'openai-compatible';

export interface OcrSettings {
  provider: OcrProvider;
  apiKey: string;
  /** For Gemini, a model like `gemini-2.0-flash-exp`. For OpenAI-compat, `gpt-4o` / `gpt-4o-mini` / etc. */
  model: string;
  /** Only used by OpenAI-compat (Groq, Together, OpenRouter, self-hosted …). */
  baseUrl?: string;
  /** Full prompt used as the text instruction to the model. */
  prompt: string;
}

const KEY = 'cookyourbooks.ocr.v1';

export const DEFAULT_PROMPT = `Extract recipe information from this image and return it as valid JSON (no markdown, no code blocks).

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
      "yield": {
        "type": "exact",
        "value": 4.0,
        "unit": "PEOPLE"
      },
      "timeEstimate": "30 minutes",
      "equipment": ["stand mixer", "baking sheet"],
      "description": "Background text or description about the recipe",
      "ingredients": [
        {
          "type": "measured",
          "name": "flour",
          "quantity": {
            "type": "exact",
            "value": 250.0,
            "unit": "GRAM"
          },
          "preparation": null,
          "notes": null
        },
        {
          "type": "measured",
          "name": "sugar",
          "quantity": {
            "type": "fractional",
            "whole": 0,
            "numerator": 1,
            "denominator": 2,
            "unit": "CUP"
          },
          "preparation": null,
          "notes": null
        },
        {
          "type": "measured",
          "name": "milk",
          "quantity": {
            "type": "range",
            "min": 2.0,
            "max": 3.0,
            "unit": "CUP"
          },
          "preparation": null,
          "notes": null
        },
        {
          "type": "vague",
          "name": "salt",
          "description": "to taste",
          "preparation": null,
          "notes": null
        },
        {
          "type": "vague",
          "name": "pepper",
          "description": "to taste",
          "preparation": null,
          "notes": null
        }
      ],
      "instructions": [
        {
          "stepNumber": 1,
          "text": "Mix 2 cups flour and 1 cup sugar together",
          "temperature": null,
          "subInstructions": [],
          "notes": null,
          "consumedIngredients": [
            {
              "ingredientName": "flour",
              "quantity": {
                "type": "exact",
                "value": 2.0,
                "unit": "CUP"
              }
            },
            {
              "ingredientName": "sugar",
              "quantity": {
                "type": "exact",
                "value": 1.0,
                "unit": "CUP"
              }
            }
          ]
        },
        {
          "stepNumber": 2,
          "text": "Add 1 cup milk gradually",
          "temperature": null,
          "subInstructions": [],
          "notes": null,
          "consumedIngredients": [
            {
              "ingredientName": "milk",
              "quantity": {
                "type": "exact",
                "value": 1.0,
                "unit": "CUP"
              }
            }
          ]
        },
        {
          "stepNumber": 3,
          "text": "Season with salt and pepper",
          "temperature": null,
          "subInstructions": [],
          "notes": null,
          "consumedIngredients": [
            {
              "ingredientName": "salt",
              "vague": true
            },
            {
              "ingredientName": "pepper",
              "vague": true
            }
          ]
        }
      ]
    }
  ],
  "rawText": "The raw text extracted from the image"
}

Important rules:
- INGREDIENT TYPE: The ingredient "type" field MUST be exactly one of: "measured" or "vague" (nothing else)
  * "measured": Use when the ingredient has a specific quantity (even if it's a range like "2-3 cups")
  * "vague": Use when the ingredient has no specific quantity (e.g., "salt to taste", "pepper", "water as needed")
  * NEVER use "range", "exact", or "fractional" as the ingredient type - these are QUANTITY types, not ingredient types
- For measured ingredients, use "type": "measured" with a "quantity" object (the quantity itself can be exact, fractional, or range)
- For vague ingredients (like "salt to taste"), use "type": "vague" with a "description" field
- MEASUREMENT PREFERENCES: When both weight and volume measures are listed, prefer weight over volume. When both metric and imperial are listed, prefer metric over imperial. For example, if you see "2 cups (250g flour)", use GRAM with value 250.0, not CUP with value 2.0.

QUANTITY TYPES (for measured ingredients and yield):
There are three types of quantities you can use:

1. EXACT QUANTITY: Use for precise decimal values (e.g., "2.5 cups", "100 grams", "3 eggs")
   Format: { "type": "exact", "value": 2.5, "unit": "CUP" }
   - value: a positive decimal number (> 0.0)
   - Examples: "2.5 cups" -> { "type": "exact", "value": 2.5, "unit": "CUP" }
               "100 g" -> { "type": "exact", "value": 100.0, "unit": "GRAM" }
               "3 eggs" -> { "type": "exact", "value": 3.0, "unit": "WHOLE" }

2. FRACTIONAL QUANTITY: Use for fractions and mixed numbers (e.g., "1/2 cup", "2 1/3 tablespoons")
   Format: { "type": "fractional", "whole": 0, "numerator": 1, "denominator": 2, "unit": "CUP" }
   - whole: the whole number part (non-negative integer, >= 0)
   - numerator: the numerator of the fraction (non-negative integer, >= 0)
   - denominator: the denominator of the fraction (positive integer, > 0)
   - At least one of whole or numerator must be positive
   - Examples: "1/2 cup" -> { "type": "fractional", "whole": 0, "numerator": 1, "denominator": 2, "unit": "CUP" }
               "2 1/3 tbsp" -> { "type": "fractional", "whole": 2, "numerator": 1, "denominator": 3, "unit": "TABLESPOON" }
               "1/4 tsp" -> { "type": "fractional", "whole": 0, "numerator": 1, "denominator": 4, "unit": "TEASPOON" }

3. RANGE QUANTITY: Use for ranges (e.g., "2-3 cups", "100-150 grams")
   Format: { "type": "range", "min": 2.0, "max": 3.0, "unit": "CUP" }
   - min: the minimum value (positive decimal, > 0.0)
   - max: the maximum value (must be greater than min)
   - Examples: "2-3 cups" -> { "type": "range", "min": 2.0, "max": 3.0, "unit": "CUP" }
               "100-150 g" -> { "type": "range", "min": 100.0, "max": 150.0, "unit": "GRAM" }

UNITS:
Valid units are organized into three categories:

IMPERIAL UNITS (volume): CUP, TABLESPOON, TEASPOON, FLUID_OUNCE
IMPERIAL UNITS (weight): OUNCE, POUND
METRIC UNITS (volume): MILLILITER, LITER, DECILITER
METRIC UNITS (weight): GRAM, KILOGRAM
COUNT UNITS: WHOLE (for counting items like eggs, cookies, loaves), PEOPLE (for serving quantities like "serves 4", "serves 4-6" - use only for yield, not ingredients)

HOUSE UNITS (informal/imprecise measurements):
These are "house" units used for small, imprecise measurements that don't have exact conversions:
- PINCH: A very small amount, typically what you can pinch between thumb and forefinger (e.g., "a pinch of salt")
- DASH: A small amount, slightly more than a pinch (e.g., "a dash of vanilla")
- HANDFUL: An amount that fits in your hand (e.g., "a handful of nuts")
- TO_TASTE: Used for vague ingredients where amount is adjusted to personal preference (e.g., "salt to taste")

- Temperature must be null OR an object like: { "value": 350, "unit": "FAHRENHEIT" }
- Include the raw text extracted from the image in the "rawText" field
- If multiple recipes are present, include all in the "recipes" array
- pageNumbers: array of integers, extract from corners or headers/footers (e.g., [123] or [123, 124] if recipe spans pages)
- bookTitle: extract from top/bottom of page if visible (null if not found)
- yield: extract yield information as a Quantity object. For "serves 4", "makes 12 cookies", "yields 1 loaf", etc., extract the numeric value and use PEOPLE unit for serving quantities (e.g., "serves 4", "serves 4-6"). Use "exact" type for single values, "range" type if a range is given (e.g., "serves 4-6"). Format: { "type": "exact", "value": 4.0, "unit": "PEOPLE" } or { "type": "range", "min": 4.0, "max": 6.0, "unit": "PEOPLE" } (null if not found). Examples: "serves 4" -> { "type": "exact", "value": 4.0, "unit": "PEOPLE" }, "serves 4-6" -> { "type": "range", "min": 4.0, "max": 6.0, "unit": "PEOPLE" }, "makes 12 cookies" -> { "type": "exact", "value": 12.0, "unit": "WHOLE" } (use WHOLE for non-serving yields like cookies, loaves, etc.), "yields 1 loaf" -> { "type": "exact", "value": 1.0, "unit": "WHOLE" }
- timeEstimate: extract time estimate if provided (e.g., "30 minutes", "1 hour", "45 min prep, 1 hour cook", "20 min prep + 30 min cook") (null if not found)
- equipment: array of strings listing special equipment needed (empty array if none)
- description: any background text, introduction, or description about the recipe (null if not found)

INSTRUCTION INGREDIENT REFERENCES:
For each instruction, identify which ingredients from the recipe's ingredient list are consumed/used in that step, along with the quantity consumed. Extract both the ingredient name and the quantity that is explicitly mentioned or clearly used in the instruction text.
- consumedIngredients: array of consumed ingredient objects. Empty array if none or unclear.
- For measured ingredients (have quantity in recipe): { "ingredientName": "flour", "quantity": { "type": "exact", "value": 2.0, "unit": "CUP" } }
- For vague ingredients (no quantity in recipe), set "vague": true and omit "quantity". For measured ingredients, always include "quantity".
- Match ingredient names case-insensitively and handle variations (e.g., "flour" matches "Flour", "all-purpose flour", etc.)
- Extract the quantity mentioned in the instruction text. If no quantity is specified, use the full recipe quantity for that ingredient.
- Only include ingredients that are explicitly mentioned or clearly used in the step
- Examples:
  * "Mix 2 cups flour and 1 cup sugar" -> [{ "ingredientName": "flour", "quantity": { "type": "exact", "value": 2.0, "unit": "CUP" } }, { "ingredientName": "sugar", "quantity": { "type": "exact", "value": 1.0, "unit": "CUP" } }]
  * "Add the milk gradually" (if recipe has "1 cup milk") -> [{ "ingredientName": "milk", "quantity": { "type": "exact", "value": 1.0, "unit": "CUP" } }]
  * "Season with salt and pepper" (if salt/pepper are vague) -> [{ "ingredientName": "salt", "vague": true }, { "ingredientName": "cracked black pepper", "vague": true }]
  * "Combine all dry ingredients" -> include all dry ingredients from the recipe with their full quantities
  * "Bake for 30 minutes" -> [] (no ingredients consumed)
  * "Add 3 eggs one at a time" -> [{ "ingredientName": "eggs", "quantity": { "type": "exact", "value": 3.0, "unit": "WHOLE" } }]
  * "Add remaining flour" (if recipe has "2 cups flour" and 1 cup was used earlier) -> [{ "ingredientName": "flour", "quantity": { "type": "exact", "value": 1.0, "unit": "CUP" } }]`;

export const DEFAULT_MODEL_BY_PROVIDER: Record<OcrProvider, string> = {
  gemini: 'gemini-2.0-flash-exp',
  'openai-compatible': 'gpt-4o-mini',
};

export function loadOcrSettings(): OcrSettings | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<OcrSettings>;
    if (!parsed.provider || !parsed.apiKey || !parsed.model || !parsed.prompt) {
      return undefined;
    }
    return {
      provider: parsed.provider,
      apiKey: parsed.apiKey,
      model: parsed.model,
      baseUrl: parsed.baseUrl,
      prompt: parsed.prompt,
    };
  } catch {
    return undefined;
  }
}

export function saveOcrSettings(s: OcrSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearOcrSettings(): void {
  localStorage.removeItem(KEY);
}
