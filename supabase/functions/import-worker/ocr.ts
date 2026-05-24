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
}

export interface OcrCallParams {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  prompt: string;
  imageBase64: string;
  mimeType: string;
  signal?: AbortSignal;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export async function runOcr(p: OcrCallParams): Promise<OcrCallResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  const signal = p.signal ?? ctrl.signal;
  try {
    if (p.provider === 'gemini') return await callGemini(p, signal, started);
    return await callOpenAI(p, signal, started);
  } catch (err) {
    const elapsed = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(message));
    return {
      errorKind: aborted ? 'TIMEOUT' : 'NETWORK',
      rawResponse: message,
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: message,
      latencyMs: elapsed,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Gemini ----------

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
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

async function callGemini(
  p: OcrCallParams,
  signal: AbortSignal,
  started: number,
): Promise<OcrCallResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    p.model,
  )}:generateContent?key=${encodeURIComponent(p.apiKey)}`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: p.prompt },
          { inline_data: { mime_type: p.mimeType, data: p.imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
    },
  };

  p.log?.('gemini POST', { model: p.model, prompt_bytes: p.prompt.length, image_bytes_b64: p.imageBase64.length });
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
  const text = cand?.content?.parts?.find((part) => typeof part.text === 'string' && part.text.length > 0)?.text;
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
    };
  }

  return {
    errorKind: 'OK',
    rawResponse: rawText,
    text,
    promptTokens,
    completionTokens,
    latencyMs,
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
  const body = {
    model: p.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: p.prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${p.mimeType};base64,${p.imageBase64}` },
          },
        ],
      },
    ],
  };

  p.log?.('openai POST', { model: p.model, base_url: base, prompt_bytes: p.prompt.length, image_bytes_b64: p.imageBase64.length });
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

  if (!text) {
    return {
      errorKind: 'OTHER',
      rawResponse: rawText,
      promptTokens,
      completionTokens,
      errorMessage: 'OpenAI-compatible response had no content.',
      latencyMs,
    };
  }

  return {
    errorKind: 'OK',
    rawResponse: rawText,
    text,
    promptTokens,
    completionTokens,
    latencyMs,
  };
}

function classifyHttp(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500 && status < 600) return 'NETWORK';
  return 'OTHER';
}
