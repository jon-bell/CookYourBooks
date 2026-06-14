// Gemini cover-image generation for the recipe cover worker.
//
// Unlike OCR (image -> JSON) this is text -> image: we send the recipe's
// name/ingredients/instructions as a prompt and ask an image-output Gemini
// model (default gemini-3.1-flash-image) to return an inline image part. The
// API surface is the same `:generateContent` endpoint used everywhere else in
// this worker — only `responseModalities: ['IMAGE']` and the response-part
// shape differ.

export interface CoverPromptInput {
  title: string;
  ingredients: string[];
  instructions: string[];
}

// Fill the user's template. The default template (see user_cover_prefs) uses
// the literal tokens RECIPE NAME / <INGREDIENTS> / <INSTRUCTIONS>; we replace
// those, trimming the ingredient/instruction lists so the prompt stays well
// under the model's context budget for a thumbnail.
export function buildCoverPrompt(template: string, input: CoverPromptInput): string {
  const ingredients = input.ingredients.filter((s) => s.trim().length > 0).join(', ');
  const instructions = input.instructions
    .filter((s) => s.trim().length > 0)
    .join(' ')
    .slice(0, 1500);
  return template
    .replaceAll('RECIPE NAME', input.title || 'this dish')
    .replaceAll('<INGREDIENTS>', ingredients || 'n/a')
    .replaceAll('<INSTRUCTIONS>', instructions || 'n/a');
}

// Collection cover: Gemini invents a cookbook cover from the collection title
// and its table of contents (recipe titles). Portrait 2:3 to match the
// collection-cover display aspect. No text — title overlay (if wanted) is the
// client-side collage path's job; image models render text poorly.
export function buildCollectionCoverPrompt(title: string, recipeTitles: string[]): string {
  const toc = recipeTitles
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 30)
    .join(', ');
  return (
    `A beautiful cookbook cover for a recipe collection titled "${title || 'Recipes'}", ` +
    `composed as a 2:3 portrait (vertical) image that fills the entire frame. ` +
    (toc ? `The collection includes recipes such as: ${toc}. ` : '') +
    `Create an appetizing, cohesive food-photography or illustrated cover that reflects ` +
    `the style and cuisine of these recipes. Photographic or illustrated image only — ` +
    `do not render any text, words, letters, numbers, labels, captions, or watermarks ` +
    `anywhere on the image.`
  );
}

interface GeminiImagePart {
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
  text?: string;
}

interface GeminiImageResponse {
  candidates?: Array<{
    content?: { parts?: GeminiImagePart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string };
}

export interface CoverGenError extends Error {
  kind: 'NO_KEY' | 'NO_IMAGE' | 'CALL_FAILED';
}

function coverError(kind: CoverGenError['kind'], message: string): CoverGenError {
  const e = new Error(message) as CoverGenError;
  e.kind = kind;
  return e;
}

export interface CoverGenResult {
  bytes: Uint8Array;
  mimeType: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function generateCover(params: {
  apiKey: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<CoverGenResult> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}` +
    `:generateContent?key=${encodeURIComponent(params.apiKey)}`;
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
      signal: params.signal,
    });
  } catch (err) {
    throw coverError('CALL_FAILED', `Gemini fetch failed: ${(err as Error).message}`);
  }
  const latencyMs = Date.now() - started;

  const rawText = await resp.text();
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw coverError('NO_KEY', `Gemini rejected the key (${resp.status}).`);
    }
    throw coverError('CALL_FAILED', `Gemini ${resp.status}: ${rawText.slice(0, 300)}`);
  }
  let parsed: GeminiImageResponse;
  try {
    parsed = JSON.parse(rawText) as GeminiImageResponse;
  } catch (err) {
    throw coverError('CALL_FAILED', `Gemini response not JSON: ${(err as Error).message}`);
  }

  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const data = imagePart?.inlineData?.data ?? imagePart?.inline_data?.data;
  if (!data) {
    throw coverError('NO_IMAGE', 'Gemini returned no image part.');
  }
  const mimeType =
    imagePart?.inlineData?.mimeType ?? imagePart?.inline_data?.mime_type ?? 'image/png';

  return {
    bytes: base64ToBytes(data),
    mimeType,
    promptTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
    latencyMs,
  };
}

export function extForMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  return 'png';
}
