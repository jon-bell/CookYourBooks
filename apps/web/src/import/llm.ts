import {
  canonicalUnitName,
  exact,
  fractional,
  instruction,
  measured,
  range,
  servings as makeServings,
  vague,
  type Ingredient,
  type IngredientRef,
  type Instruction,
  type ParsedRecipeDraft,
  type Quantity,
  type Servings,
  type Temperature,
} from '@cookyourbooks/domain';
import type { OcrSettings } from '../settings/ocrSettings.js';

export type OcrProgress = { status: string };

/**
 * Send an image plus the user's pre-tuned prompt to the configured LLM
 * provider and parse the returned JSON into one or more
 * {@link ParsedRecipeDraft} objects. A single photograph can contain
 * multiple recipes (e.g. a cookbook spread), so the parser always
 * returns an array — callers are responsible for surfacing a picker
 * when `length > 1`.
 *
 * Errors from the API surface verbatim — the caller renders them inline
 * so the user can fix the key / model name without digging into
 * devtools.
 */
export async function ocrWithLlm(
  image: Blob | File,
  settings: OcrSettings,
  onProgress?: (p: OcrProgress) => void,
): Promise<ParsedRecipeDraft[]> {
  onProgress?.({ status: 'encoding image' });
  const b64 = await blobToBase64(image);
  const mime = image.type || 'image/jpeg';

  onProgress?.({ status: `asking ${settings.provider}` });
  const raw =
    settings.provider === 'gemini'
      ? await callGemini(b64, mime, settings)
      : await callOpenAI(b64, mime, settings);

  onProgress?.({ status: 'parsing response' });
  return parseLlmJson(raw);
}

// ---------- Gemini ----------

async function callGemini(b64: string, mime: string, settings: OcrSettings): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    settings.model,
  )}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: settings.prompt },
          { inline_data: { mime_type: mime, data: b64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Gemini ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text part');
  return text;
}

// ---------- OpenAI-compatible ----------

async function callOpenAI(b64: string, mime: string, settings: OcrSettings): Promise<string> {
  const base = (settings.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const body = {
    model: settings.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: settings.prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${b64}` },
          },
        ],
      },
    ],
  };
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`OpenAI-compatible ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI-compatible response had no content');
  return text;
}

// ---------- JSON → domain ----------

/**
 * Parse the model's JSON response. Accepts a deliberately wide range
 * of shapes:
 *   - `{ recipes: [...] }` — the rich prompt (preferred, multi-recipe)
 *   - a single recipe object at the top level (legacy)
 *   - types in either upper- or lower-case (MEASURED / measured)
 *   - exact quantities expressed as `value` or `amount`
 *   - unit names as catalog keys ("CUP"), canonical names ("cup"),
 *     or known abbreviations ("tsp") — all canonicalized on the way in
 *
 * Malformed entries are dropped into `leftover` rather than throwing
 * so a partial-OCR photo still surfaces something editable.
 */
export function parseLlmJson(text: string): ParsedRecipeDraft[] {
  const cleaned = stripFences(text).trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Could not parse LLM JSON: ${(err as Error).message}. Got: ${text.slice(0, 200)}`,
    );
  }

  // Top-level shape detection.
  let recipeObjects: unknown[];
  let rawText: string | undefined;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.rawText === 'string') rawText = obj.rawText;
    if (Array.isArray(obj.recipes)) recipeObjects = obj.recipes;
    else if (Array.isArray(obj.ingredients) || typeof obj.title === 'string')
      recipeObjects = [obj];
    else recipeObjects = [];
  } else if (Array.isArray(raw)) {
    recipeObjects = raw;
  } else {
    recipeObjects = [];
  }

  const drafts: ParsedRecipeDraft[] = [];
  for (const r of recipeObjects) {
    const draft = buildDraft(r, rawText);
    // Skip genuinely empty drafts — the model sometimes emits a
    // placeholder recipe alongside the real one.
    if (
      draft.title ||
      draft.ingredients.length > 0 ||
      draft.instructions.length > 0 ||
      draft.description ||
      (draft.pageNumbers && draft.pageNumbers.length > 0)
    ) {
      drafts.push(draft);
    }
  }
  // Always return at least one draft so downstream code can render a
  // useful (even if empty) editor.
  if (drafts.length === 0) {
    drafts.push({
      title: undefined,
      ingredients: [],
      instructions: [],
      leftover: rawText ? [rawText] : [],
      sourceImageText: rawText,
    });
  }
  return drafts;
}

function buildDraft(
  raw: unknown,
  rawText: string | undefined,
): ParsedRecipeDraft {
  if (!raw || typeof raw !== 'object') {
    return { ingredients: [], instructions: [], leftover: [], sourceImageText: rawText };
  }
  const obj = raw as Record<string, unknown>;

  // Ingredients first — we need their ids to resolve step refs.
  const ingredients: Ingredient[] = [];
  const leftover: string[] = [];
  for (const rawIng of arrayOrEmpty(obj.ingredients)) {
    const built = tryIngredient(rawIng);
    if (built) ingredients.push(built);
    else leftover.push(JSON.stringify(rawIng));
  }

  // Name → id map for consumedIngredients resolution. Case-insensitive
  // exact match first, substring fallback (so "flour" matches
  // "all-purpose flour").
  const byLowerName = new Map<string, string>();
  for (const ing of ingredients) byLowerName.set(ing.name.toLowerCase(), ing.id);
  function resolveIngredientId(name: string): string | undefined {
    const lower = name.trim().toLowerCase();
    if (!lower) return undefined;
    const exactHit = byLowerName.get(lower);
    if (exactHit) return exactHit;
    for (const [candidate, id] of byLowerName) {
      if (candidate.includes(lower) || lower.includes(candidate)) return id;
    }
    return undefined;
  }

  const instructions: Instruction[] = [];
  for (const rawStep of arrayOrEmpty(obj.instructions)) {
    const built = tryInstruction(rawStep, instructions.length + 1, resolveIngredientId);
    if (built) instructions.push(built);
  }

  const yieldServings = tryServings(obj.yield) ?? tryServings(obj.servings);

  const pageNumbers = toNumberArray(obj.pageNumbers);
  const equipment = toStringArray(obj.equipment);

  return {
    title: asTrimmedString(obj.title),
    servings: yieldServings,
    ingredients,
    instructions,
    leftover,
    description: asTrimmedString(obj.description),
    timeEstimate: asTrimmedString(obj.timeEstimate),
    equipment,
    bookTitle: asTrimmedString(obj.bookTitle),
    pageNumbers,
    sourceImageText: rawText,
  };
}

function tryIngredient(raw: unknown): Ingredient | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const name = asTrimmedString(obj.name);
  if (!name) return undefined;
  const preparation = asTrimmedString(obj.preparation);
  const notes = asTrimmedString(obj.notes);
  const description = asTrimmedString(obj.description);
  const type = typeOf(obj.type);
  if (type === 'vague') {
    return vague({ name, preparation, notes, description });
  }
  if (type === 'measured') {
    const q = tryQuantity(obj.quantity);
    if (!q) {
      // Measured but the quantity didn't parse — keep the ingredient as
      // vague with the raw blob in notes so the user can still edit it.
      return vague({ name, preparation, notes, description });
    }
    return measured({ name, preparation, notes, quantity: q });
  }
  // No/unknown type — infer from presence of a quantity object.
  const q = tryQuantity(obj.quantity);
  if (q) return measured({ name, preparation, notes, quantity: q });
  return vague({ name, preparation, notes, description });
}

function tryQuantity(raw: unknown): Quantity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const t = typeOf(obj.type);
  const unit = canonicalUnitName(asString(obj.unit));
  try {
    switch (t) {
      case 'exact': {
        // The rich prompt uses `value`; the legacy prompt used
        // `amount`. Accept either.
        const n = asFiniteNumber(obj.value) ?? asFiniteNumber(obj.amount);
        if (n === undefined) return undefined;
        return exact(n, unit);
      }
      case 'fractional': {
        const whole = asFiniteNumber(obj.whole);
        const num = asFiniteNumber(obj.numerator);
        const den = asFiniteNumber(obj.denominator);
        if (whole === undefined || num === undefined || den === undefined) return undefined;
        return fractional(whole, num, den, unit);
      }
      case 'range': {
        const min = asFiniteNumber(obj.min);
        const max = asFiniteNumber(obj.max);
        if (min === undefined || max === undefined) return undefined;
        return range(min, max, unit);
      }
      default:
        return undefined;
    }
  } catch {
    // Factory validation rejected (e.g. negative amount). Drop it.
    return undefined;
  }
}

function trySubInstructions(raw: unknown): string[] | undefined {
  const arr = asArray(raw);
  if (!arr) return undefined;
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push(t);
    } else if (item && typeof item === 'object') {
      const t = asTrimmedString((item as Record<string, unknown>).text);
      if (t) out.push(t);
    }
  }
  return out.length > 0 ? out : undefined;
}

function tryTemperature(raw: unknown): Temperature | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const value = asFiniteNumber(obj.value);
  if (value === undefined) return undefined;
  const unit = asString(obj.unit)?.toUpperCase();
  if (unit !== 'FAHRENHEIT' && unit !== 'CELSIUS') return undefined;
  return { value, unit };
}

function tryConsumedRefs(
  raw: unknown,
  resolve: (name: string) => string | undefined,
): IngredientRef[] {
  const arr = asArray(raw);
  if (!arr) return [];
  const refs: IngredientRef[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = asTrimmedString(obj.ingredientName) ?? asTrimmedString(obj.name);
    if (!name) continue;
    const id = resolve(name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({ ingredientId: id, quantity: tryQuantity(obj.quantity) });
  }
  return refs;
}

function tryInstruction(
  raw: unknown,
  fallbackStepNumber: number,
  resolveIngredientId: (name: string) => string | undefined,
): Instruction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const text = asTrimmedString(obj.text);
  if (!text) return undefined;
  const stepNumber = asFiniteNumber(obj.stepNumber) ?? fallbackStepNumber;
  return instruction({
    stepNumber,
    text,
    ingredientRefs: tryConsumedRefs(obj.consumedIngredients, resolveIngredientId),
    temperature: tryTemperature(obj.temperature),
    subInstructions: trySubInstructions(obj.subInstructions),
    notes: asTrimmedString(obj.notes),
  });
}

function tryServings(raw: unknown): Servings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  // Legacy shape: `{amount, description}`.
  if ('amount' in obj && !('type' in obj)) {
    const amount = asFiniteNumber(obj.amount);
    if (amount === undefined || amount <= 0) return undefined;
    try {
      return makeServings(amount, asTrimmedString(obj.description));
    } catch {
      return undefined;
    }
  }
  // Rich shape: a Quantity-like object with a `unit` that labels the
  // servings ("people", "piece"/"whole", "cookies", etc.).
  const q = tryQuantity(obj);
  if (!q) return undefined;
  const unitName = canonicalUnitName(q.unit);
  // Empty / generic "piece" collapses to the default "servings" copy.
  const description = unitName && unitName !== 'piece' ? unitName : undefined;
  try {
    switch (q.type) {
      case 'EXACT':
        return makeServings(q.amount, description);
      case 'FRACTIONAL':
        return makeServings(q.whole + q.numerator / q.denominator, description);
      case 'RANGE':
        return makeServings(q.min, description, q.max);
    }
  } catch {
    return undefined;
  }
}

// ---------- shared little helpers ----------

function arrayOrEmpty(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function asArray(raw: unknown): unknown[] | undefined {
  return Array.isArray(raw) ? raw : undefined;
}

function asString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function asTrimmedString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

function asFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function typeOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function toStringArray(raw: unknown): string[] | undefined {
  const arr = asArray(raw);
  if (!arr) return undefined;
  const out = arr
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : undefined;
}

function toNumberArray(raw: unknown): number[] | undefined {
  const arr = asArray(raw);
  if (!arr) return undefined;
  const out = arr
    .map((x) => asFiniteNumber(x))
    .filter((x): x is number => x !== undefined);
  return out.length > 0 ? out : undefined;
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
