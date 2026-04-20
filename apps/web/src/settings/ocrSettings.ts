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

export const DEFAULT_PROMPT = `You are extracting a recipe from a photograph. Read the image and return STRICT JSON — no prose, no markdown fences, no commentary — matching exactly this TypeScript shape:

{
  "title": string,
  "servings": { "amount": number, "description"?: string } | null,
  "ingredients": Array<
    | { "type": "MEASURED", "name": string, "preparation"?: string,
        "quantity": { "type": "EXACT", "amount": number, "unit": string }
                  | { "type": "FRACTIONAL", "whole": number, "numerator": number, "denominator": number, "unit": string }
                  | { "type": "RANGE", "min": number, "max": number, "unit": string } }
    | { "type": "VAGUE", "name": string, "preparation"?: string }
  >,
  "instructions": Array<{ "stepNumber": number, "text": string }>
}

Rules:
- Use VAGUE for ingredients without a measurable amount (e.g. "salt to taste").
- Preserve fractions as FRACTIONAL; otherwise use EXACT decimals.
- Unit names should be singular English: cup, tablespoon, teaspoon, gram, kilogram, milliliter, liter, ounce, pound, piece, clove, bunch, pinch, dash.
- If a field is unreadable, omit ingredients/instructions rather than inventing content.`;

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
