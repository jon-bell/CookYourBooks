import {
  exact,
  fractional,
  instruction,
  measured,
  range,
  servings as makeServings,
  vague,
  type Ingredient,
  type Instruction,
  type ParsedRecipeDraft,
  type Quantity,
  type Servings,
} from '@cookyourbooks/domain';
import type { OcrSettings } from '../settings/ocrSettings.js';

export type OcrProgress = { status: string };

/**
 * Send an image plus the user's pre-tuned prompt to the configured LLM
 * provider and parse the returned JSON into a {@link ParsedRecipeDraft}.
 *
 * Errors from the API surface verbatim — the caller renders them inline
 * so the user can fix the key / model name without digging into devtools.
 */
export async function ocrWithLlm(
  image: Blob | File,
  settings: OcrSettings,
  onProgress?: (p: OcrProgress) => void,
): Promise<ParsedRecipeDraft> {
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

interface RawQuantityExact {
  type: 'EXACT';
  amount: number;
  unit: string;
}
interface RawQuantityFractional {
  type: 'FRACTIONAL';
  whole: number;
  numerator: number;
  denominator: number;
  unit: string;
}
interface RawQuantityRange {
  type: 'RANGE';
  min: number;
  max: number;
  unit: string;
}
type RawQuantity = RawQuantityExact | RawQuantityFractional | RawQuantityRange;

interface RawMeasured {
  type: 'MEASURED';
  name: string;
  preparation?: string;
  quantity: RawQuantity;
}
interface RawVague {
  type: 'VAGUE';
  name: string;
  preparation?: string;
}
type RawIngredient = RawMeasured | RawVague;

interface RawInstruction {
  stepNumber: number;
  text: string;
}
interface RawServings {
  amount: number;
  description?: string;
}
interface RawResponse {
  title?: string;
  servings?: RawServings | null;
  ingredients?: RawIngredient[];
  instructions?: RawInstruction[];
}

/**
 * Parse the model's JSON response into our domain draft. We intentionally
 * accept a trailing ```json fence if the provider ignores the JSON-mode
 * instruction, and quietly drop malformed entries rather than throwing —
 * better to hand the user an editable partial draft than a hard error.
 */
export function parseLlmJson(text: string): ParsedRecipeDraft {
  const cleaned = stripFences(text).trim();
  let raw: RawResponse;
  try {
    raw = JSON.parse(cleaned) as RawResponse;
  } catch (err) {
    throw new Error(`Could not parse LLM JSON: ${(err as Error).message}. Got: ${text.slice(0, 200)}`);
  }

  const ingredients: Ingredient[] = [];
  const leftover: string[] = [];
  for (const ing of raw.ingredients ?? []) {
    const built = tryIngredient(ing);
    if (built) ingredients.push(built);
    else leftover.push(JSON.stringify(ing));
  }

  const instructions: Instruction[] = [];
  for (const step of raw.instructions ?? []) {
    if (!step || typeof step.text !== 'string' || !step.text.trim()) continue;
    const n = typeof step.stepNumber === 'number' ? step.stepNumber : instructions.length + 1;
    instructions.push(instruction({ stepNumber: n, text: step.text.trim() }));
  }

  let srv: Servings | undefined;
  if (raw.servings && typeof raw.servings.amount === 'number' && raw.servings.amount > 0) {
    srv = makeServings(raw.servings.amount, raw.servings.description?.trim() || undefined);
  }

  return {
    title: raw.title?.trim() || undefined,
    servings: srv,
    ingredients,
    instructions,
    leftover,
  };
}

function tryIngredient(raw: RawIngredient): Ingredient | undefined {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) return undefined;
  if (raw.type === 'VAGUE') {
    return vague({ name: raw.name.trim(), preparation: raw.preparation?.trim() || undefined });
  }
  if (raw.type === 'MEASURED') {
    const q = tryQuantity(raw.quantity);
    if (!q) return undefined;
    return measured({
      name: raw.name.trim(),
      preparation: raw.preparation?.trim() || undefined,
      quantity: q,
    });
  }
  return undefined;
}

function tryQuantity(raw: RawQuantity | undefined): Quantity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  try {
    switch (raw.type) {
      case 'EXACT':
        if (typeof raw.amount !== 'number' || typeof raw.unit !== 'string') return undefined;
        return exact(raw.amount, raw.unit);
      case 'FRACTIONAL':
        if (
          typeof raw.whole !== 'number' ||
          typeof raw.numerator !== 'number' ||
          typeof raw.denominator !== 'number' ||
          typeof raw.unit !== 'string'
        )
          return undefined;
        return fractional(raw.whole, raw.numerator, raw.denominator, raw.unit);
      case 'RANGE':
        if (typeof raw.min !== 'number' || typeof raw.max !== 'number' || typeof raw.unit !== 'string')
          return undefined;
        return range(raw.min, raw.max, raw.unit);
      default:
        return undefined;
    }
  } catch {
    // Factory validation rejected (e.g. negative amount). Drop it.
    return undefined;
  }
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
