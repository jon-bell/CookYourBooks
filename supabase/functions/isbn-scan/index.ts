// ISBN-from-photo Edge Function.
//
//   POST /functions/v1/isbn-scan { imageBase64: string, mimeType?: string }
//     → { isbn: string | null }
//
// Reads the ISBN off a photographed book cover or barcode using Gemini
// vision. We use an LLM rather than the browser BarcodeDetector API because
// that API isn't available in the iOS Capacitor WebView, and a cover photo
// (no clean barcode) still resolves. The user's own Gemini key (or a borrowed
// household key) is read from Vault via the `ocr_resolve_effective_key` RPC —
// same mechanism as video-import and the OCR import-worker — so it never
// reaches the browser bundle. Each scan's token usage is metered into the LLM
// Cost Center via misc_llm_usage_record (best-effort).
//
// Errors carry a machine-readable `code`: NO_GEMINI_KEY · NO_ISBN_FOUND ·
// SCAN_FAILED.

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import * as Sentry from 'https://esm.sh/@sentry/deno@9.46.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Flash is the right cost/latency tier for reading a few digits off a cover.
const ISBN_MODEL = Deno.env.get('ISBN_SCAN_MODEL') || 'gemini-2.5-flash';

const SENTRY_DSN = Deno.env.get('SENTRY_DSN');
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: Deno.env.get('SENTRY_RELEASE') ?? undefined,
    environment: Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production',
    defaultIntegrations: false,
    tracesSampleRate: 1.0,
    initialScope: { tags: { component: 'isbn-scan' } },
  });
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------- ISBN normalization ----------

// Mirrors apps/web/src/books/openLibrary.ts `normalizeIsbn`. Returns null
// when the cleaned value isn't a plausible ISBN-10/13.
function normalizeIsbn(input: string): string | null {
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  if (!/^\d{9}[\dX]$|^\d{13}$/.test(cleaned)) return null;
  return cleaned;
}

// ---------- prompt ----------

const ISBN_PROMPT = `You are reading the ISBN off a photograph of a book — either its cover, back cover, or the barcode/EAN printed near it.
Return ONLY a JSON object: { "isbn": "<the 13- or 10-digit ISBN, digits only>" } or { "isbn": null } if no ISBN is visible.
Rules:
- Prefer the ISBN-13 (starts 978 or 979) when both are shown.
- Output digits only — strip the "ISBN", hyphens, and spaces.
- Do not guess or invent digits. If you cannot read a full, confident ISBN, return null.`;

// ---------- Gemini ----------

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string };
}

interface GeminiCallResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

async function callGemini(
  apiKey: string,
  imageBase64: string,
  mimeType: string,
): Promise<GeminiCallResult> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ISBN_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: ISBN_PROMPT },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          },
        ],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;

  const rawText = await resp.text();
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new HttpError('NO_GEMINI_KEY', `Gemini rejected the key (${resp.status}).`);
    }
    throw new HttpError('SCAN_FAILED', `Gemini ${resp.status}: ${rawText.slice(0, 300)}`);
  }
  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(rawText) as GeminiResponse;
  } catch (err) {
    throw new HttpError('SCAN_FAILED', `Gemini response not JSON: ${(err as Error).message}`);
  }
  const text = parsed.candidates?.[0]?.content?.parts?.find(
    (p) => typeof p.text === 'string' && p.text.length > 0,
  )?.text;
  if (!text) throw new HttpError('SCAN_FAILED', 'Gemini returned no text.');
  return {
    text,
    promptTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
    latencyMs,
  };
}

// ---------- key resolution ----------

// ocr_resolve_effective_key (not ocr_resolve_key) so a household member who
// borrows the shared key is honored AND the LLM Cost Center can attribute the
// spend to whoever's key actually paid (key_owner_id).
async function resolveGeminiKey(
  ownerId: string,
): Promise<{ apiKey: string; keyOwnerId: string | null }> {
  const { data, error } = await sb.rpc('ocr_resolve_effective_key', {
    p_owner_id: ownerId,
    p_provider: 'gemini',
  });
  if (error) throw new HttpError('SCAN_FAILED', `key lookup: ${error.message}`);
  const row = Array.isArray(data)
    ? (data[0] as { api_key?: string; key_owner_id?: string } | undefined)
    : undefined;
  if (!row?.api_key) {
    throw new HttpError('NO_GEMINI_KEY', 'No Gemini API key configured for this user.');
  }
  return { apiKey: row.api_key, keyOwnerId: row.key_owner_id ?? null };
}

// ---------- cost metering ----------

// Best-effort record into the LLM Cost Center ledger. A ledger failure must
// NEVER fail the user's scan — swallow everything.
async function recordMiscUsage(
  client: SupabaseClient,
  e: {
    ownerId: string;
    keyOwnerId: string | null;
    feature: 'isbn' | 'video';
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    errorKind: string;
    producedRef?: string;
    producedKind: string;
  },
): Promise<void> {
  try {
    const { error } = await client.rpc('misc_llm_usage_record', {
      p_event: {
        owner_id: e.ownerId,
        key_owner_id: e.keyOwnerId,
        feature: e.feature,
        provider: e.provider,
        model: e.model,
        prompt_tokens: e.promptTokens,
        completion_tokens: e.completionTokens,
        latency_ms: e.latencyMs,
        error_kind: e.errorKind,
        produced_ref: e.producedRef ?? null,
        produced_kind: e.producedKind,
      },
    });
    if (error) console.error('misc_llm_usage_record failed', error.message);
  } catch (err) {
    console.error('misc_llm_usage_record threw', (err as Error).message);
  }
}

// ---------- HTTP handler ----------

class HttpError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function requireAuth(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  if (token === SERVICE_ROLE_KEY) return 'service_role';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

Deno.serve(async (req) => {
  return await Sentry.withScope(async () => {
    try {
      return await handle(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, code: err.code }, err.code === 'NO_GEMINI_KEY' ? 400 : 422);
      }
      if (SENTRY_DSN) Sentry.captureException(err);
      console.error('unhandled invocation error', err);
      return json({ error: 'internal' }, 500);
    } finally {
      if (SENTRY_DSN) await Sentry.flush(2000);
    }
  });
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const caller = await requireAuth(req);
  if (!caller) return json({ error: 'unauthorized' }, 401);
  if (caller === 'service_role') {
    throw new HttpError('NO_GEMINI_KEY', 'Service-role caller has no user Gemini key.');
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
  const mimeType = typeof body.mimeType === 'string' && body.mimeType ? body.mimeType : 'image/jpeg';
  if (!imageBase64) return json({ error: 'missing image', code: 'SCAN_FAILED' }, 400);

  const { apiKey, keyOwnerId } = await resolveGeminiKey(caller);
  const result = await callGemini(apiKey, imageBase64, mimeType);

  let raw: unknown;
  try {
    raw = JSON.parse(result.text);
  } catch {
    throw new HttpError('SCAN_FAILED', 'Scanner returned malformed JSON.');
  }
  const candidate =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).isbn : undefined;
  const isbn = typeof candidate === 'string' ? normalizeIsbn(candidate) : null;

  // Meter the Gemini call (whether or not an ISBN was read — it cost the same).
  await recordMiscUsage(sb, {
    ownerId: caller,
    keyOwnerId,
    feature: 'isbn',
    provider: 'gemini',
    model: ISBN_MODEL,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs: result.latencyMs,
    errorKind: 'OK',
    producedRef: isbn ?? undefined,
    producedKind: 'ISBN',
  });

  if (!isbn) return json({ error: 'No ISBN found in the image.', code: 'NO_ISBN_FOUND' }, 422);

  return json({ isbn });
}
