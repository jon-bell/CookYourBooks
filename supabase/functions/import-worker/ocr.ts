// LLM call layer: Gemini + OpenAI-compatible. Returns a normalized
// `OcrCallResult` so the worker loop doesn't have to know provider
// shapes.

export type ErrorKind =
  | 'OK'
  | 'RECITATION'
  | 'RATE_LIMIT'
  | 'AUTH'
  | 'NETWORK'
  | 'PARSE'
  | 'TIMEOUT'
  | 'OTHER';

export type Provider = 'gemini' | 'openai-compatible';

export interface OcrCallResult {
  errorKind: ErrorKind;
  rawResponse: string;
  text?: string;
  promptTokens: number;
  completionTokens: number;
  errorMessage?: string;
  latencyMs: number;
  /** Provider finish reason (`STOP`/`MAX_TOKENS` for Gemini, `stop`/`length`/…
   *  for OpenAI-compatible) so a downstream parse failure can say "the model
   *  ran out of output budget" instead of showing raw JSON soup. */
  finishReason?: string;
}

export interface OcrImage {
  base64: string;
  mimeType: string;
}

export interface OcrCallParams {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  prompt: string;
  /** One entry for a normal scan; multiple when the user merged
   *  additional pages onto the primary item — sent to the LLM in the
   *  same call so the recipe survives mid-recipe page breaks. */
  images: readonly OcrImage[];
  signal?: AbortSignal;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

// Per-call LLM timeout, in ms. Scales with image count so a merged
// multi-page item gets enough headroom: Gemini's response time grows
// roughly linearly with input bytes, and a 3-page recipe extraction
// can easily exceed 90s on the default model.
//
// Tunable via env so users on Supabase Pro+ (400s function ceiling)
// can raise the budgets without a redeploy of this file:
//   OCR_TIMEOUT_BASE_MS   — first-image budget. Default 90s.
//   OCR_TIMEOUT_PER_IMG_MS — extra per additional image. Default 45s.
//   OCR_TIMEOUT_CAP_MS    — absolute cap. Default 270s (sub-platform
//                            ceiling for hosted Edge Functions).
const TIMEOUT_BASE_MS = parseIntEnv('OCR_TIMEOUT_BASE_MS', 90_000);
const TIMEOUT_PER_IMG_MS = parseIntEnv('OCR_TIMEOUT_PER_IMG_MS', 45_000);
const TIMEOUT_CAP_MS = parseIntEnv('OCR_TIMEOUT_CAP_MS', 270_000);

function parseIntEnv(name: string, fallback: number): number {
  const raw = (globalThis as { Deno?: { env: { get(name: string): string | undefined } } }).Deno?.env?.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function ocrTimeoutForImages(count: number): number {
  const extras = Math.max(0, count - 1);
  return Math.min(TIMEOUT_CAP_MS, TIMEOUT_BASE_MS + extras * TIMEOUT_PER_IMG_MS);
}

export async function runOcr(p: OcrCallParams): Promise<OcrCallResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const budget = ocrTimeoutForImages(p.images.length);
  const timer = setTimeout(() => ctrl.abort(), budget);
  const signal = p.signal ?? ctrl.signal;
  p.log?.('ocr call begin', { provider: p.provider, model: p.model, images: p.images.length, budget_ms: budget });
  try {
    if (p.provider === 'gemini') return await callGemini(p, signal, started);
    return await callOpenAI(p, signal, started);
  } catch (err) {
    const elapsed = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(message));
    if (aborted) {
      p.log?.('ocr call aborted (timeout)', { budget_ms: budget, elapsed_ms: elapsed, images: p.images.length });
    }
    return {
      errorKind: aborted ? 'TIMEOUT' : 'NETWORK',
      rawResponse: message,
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: aborted
        ? `OCR timed out after ${elapsed}ms (budget ${budget}ms for ${p.images.length} image(s)).`
        : message,
      latencyMs: elapsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Gemini ----------

// A single `content.parts[]` entry. Thinking models (gemini-3.x) attach a
// `thoughtSignature` to the answer part and, when thought summaries are on,
// emit separate `thought: true` parts whose `text` is reasoning prose, not
// the answer. We must skip those.
interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Pull the answer text out of a Gemini candidate. Concatenates every
 * non-empty text part while skipping thought-summary parts (`thought:
 * true`), so a thinking-model response — where the JSON answer may be
 * split across parts or preceded by reasoning prose — still yields the
 * whole answer and never the thinking. Returns undefined when there's no
 * answer text at all. Kept in sync with the sibling import Edge Functions.
 */
export function extractGeminiText(cand: GeminiCandidate | undefined): string | undefined {
  const parts = cand?.content?.parts;
  if (!parts) return undefined;
  const joined = parts
    .filter((part) => part.thought !== true && typeof part.text === 'string' && part.text.length > 0)
    .map((part) => part.text)
    .join('');
  return joined.length > 0 ? joined : undefined;
}

async function callGemini(
  p: OcrCallParams,
  signal: AbortSignal,
  started: number,
): Promise<OcrCallResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    p.model,
  )}:generateContent?key=${encodeURIComponent(p.apiKey)}`;
  // When called for text-only tasks (e.g. instruction rewriting) we
  // send the prompt-only parts. Gemini accepts a single text-only part
  // just fine.
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: p.prompt },
          ...p.images.map((img) => ({
            inline_data: { mime_type: img.mimeType, data: img.base64 },
          })),
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
    },
  };

  p.log?.('gemini POST', {
    model: p.model,
    prompt_bytes: p.prompt.length,
    images: p.images.length,
    image_bytes_b64: p.images.reduce((acc, i) => acc + i.base64.length, 0),
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const rawText = await resp.text();
  const latencyMs = Date.now() - started;
  p.log?.('gemini response', { status: resp.status, body_bytes: rawText.length, latency_ms: latencyMs });

  if (!resp.ok) {
    return {
      errorKind: classifyHttp(resp.status),
      rawResponse: rawText,
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: `Gemini ${resp.status}: ${rawText.slice(0, 300)}`,
      latencyMs,
    };
  }

  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(rawText) as GeminiResponse;
  } catch (err) {
    return {
      errorKind: 'PARSE',
      rawResponse: rawText,
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: `Gemini response not JSON: ${(err as Error).message}`,
      latencyMs,
    };
  }

  const promptTokens = parsed.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = parsed.usageMetadata?.candidatesTokenCount ?? 0;

  const cand = parsed.candidates?.[0];
  const text = extractGeminiText(cand);
  const finish = cand?.finishReason;

  if (!text) {
    const recitation =
      finish === 'RECITATION' || (finish !== undefined && finish !== 'STOP' && finish !== 'MAX_TOKENS');
    return {
      errorKind: recitation ? 'RECITATION' : 'OTHER',
      rawResponse: rawText,
      promptTokens,
      completionTokens,
      errorMessage: recitation
        ? `Gemini refused due to ${finish ?? 'recitation'} guardrail.`
        : 'Gemini returned no text part.',
      latencyMs,
      finishReason: finish,
    };
  }

  if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
    return {
      errorKind: 'RECITATION',
      rawResponse: rawText,
      promptTokens,
      completionTokens,
      errorMessage: `Gemini stopped early (${finish}).`,
      latencyMs,
      finishReason: finish,
    };
  }

  return {
    errorKind: 'OK',
    rawResponse: rawText,
    text,
    promptTokens,
    completionTokens,
    latencyMs,
    finishReason: finish,
  };
}

// ---------- OpenAI-compatible ----------

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

async function callOpenAI(
  p: OcrCallParams,
  signal: AbortSignal,
  started: number,
): Promise<OcrCallResult> {
  const base = (p.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  // Don't pin temperature. The newer reasoning-family models (o-series,
  // gpt-5+) reject any non-default temperature with a 400. JSON mode
  // below is what actually constrains the output shape; determinism
  // isn't worth losing those models as a fallback.
  const body = {
    model: p.model,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: p.prompt },
          ...p.images.map((img) => ({
            type: 'image_url' as const,
            image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
          })),
        ],
      },
    ],
  };

  p.log?.('openai POST', {
    model: p.model,
    base_url: base,
    prompt_bytes: p.prompt.length,
    images: p.images.length,
    image_bytes_b64: p.images.reduce((acc, i) => acc + i.base64.length, 0),
  });
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const rawText = await resp.text();
  const latencyMs = Date.now() - started;
  p.log?.('openai response', { status: resp.status, body_bytes: rawText.length, latency_ms: latencyMs });

  if (!resp.ok) {
    return {
      errorKind: classifyHttp(resp.status),
      rawResponse: rawText,
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: `OpenAI-compatible ${resp.status}: ${rawText.slice(0, 300)}`,
      latencyMs,
    };
  }

  let parsed: OpenAIResponse;
  try {
    parsed = JSON.parse(rawText) as OpenAIResponse;
  } catch (err) {
    return {
      errorKind: 'PARSE',
      rawResponse: rawText,
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: `OpenAI response not JSON: ${(err as Error).message}`,
      latencyMs,
    };
  }

  const promptTokens = parsed.usage?.prompt_tokens ?? 0;
  const completionTokens = parsed.usage?.completion_tokens ?? 0;
  const text = parsed.choices?.[0]?.message?.content;
  const finish = parsed.choices?.[0]?.finish_reason;
  const finishClass = classifyOpenAIFinish(finish);

  // A guardrail stop (`content_filter` etc.) truncates the JSON mid-value —
  // unrecoverable by the tolerant parser, so don't let it masquerade as a
  // parse error. RECITATION routes it into the same needs_fallback / retry
  // machinery as Gemini's recitation refusals. The message must contain the
  // substring "recitation": the batch board detects these failures by it.
  if (finishClass === 'refusal') {
    return {
      errorKind: 'RECITATION',
      rawResponse: rawText,
      promptTokens,
      completionTokens,
      errorMessage: `Model stopped early (finish_reason=${finish}) — content-filter/recitation refusal.`,
      latencyMs,
      finishReason: finish,
    };
  }

  if (!text) {
    return {
      errorKind: 'OTHER',
      rawResponse: rawText,
      promptTokens,
      completionTokens,
      errorMessage: 'OpenAI-compatible response had no content.',
      latencyMs,
      finishReason: finish,
    };
  }

  // `length` (truncated) still reaches the parser: an under-closed tail may
  // be salvageable, and parseAndComplete prefixes the failure message with
  // the truncation cause via `finishReason` when it isn't.
  return {
    errorKind: 'OK',
    rawResponse: rawText,
    text,
    promptTokens,
    completionTokens,
    latencyMs,
    finishReason: finish,
  };
}

/**
 * Classify an OpenAI-compatible `finish_reason`. `stop` (or absent) is a
 * clean finish; `length` means the output budget truncated the JSON;
 * anything else (`content_filter`, `tool_calls`, vendor-specific values)
 * is treated as a refusal — the content is not trustworthy JSON.
 */
export function classifyOpenAIFinish(finish: string | undefined): 'ok' | 'truncated' | 'refusal' {
  if (finish === undefined || finish === 'stop') return 'ok';
  if (finish === 'length') return 'truncated';
  return 'refusal';
}

function classifyHttp(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500 && status < 600) return 'NETWORK';
  return 'OTHER';
}
