// PDF recipe import Edge Function.
//
//   POST /functions/v1/pdf-import
//     { pages: string[] /* base64 JPEGs, in order */, sourceUrl?: string|null, mimeType?: string }
//     → { sourceUrl, platformTitle, drafts: ParsedRecipeDraft[] }
//
// An iOS user prints a (often paywalled) recipe to PDF in Safari and shares it
// to CookYourBooks. The client renders the PDF's pages to JPEGs and reads the
// source URL out of the print header/footer text layer, then posts them here.
// We feed ALL pages to Gemini in ONE call so a recipe that spans page breaks is
// extracted as a single recipe, and stamp the source URL onto it.
//
// Same auth / key / metering posture as video-import and the OCR import-worker:
//   - JWT (or service-role) auth in requireAuth().
//   - The user's own Gemini key is read from Vault via ocr_resolve_effective_key
//     so it never reaches the browser bundle.
//   - Each real Gemini call is metered into the LLM Cost Center via
//     misc_llm_usage_record (best-effort; never fails the import).
//
// Errors carry a machine-readable `code`: NO_GEMINI_KEY · EXTRACTION_FAILED.

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import * as Sentry from 'https://esm.sh/@sentry/deno@9.46.0';
import { parseLlmJson, type ParsedRecipeDraft } from './parser.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Vision-capable Gemini model — same default/override knob as video-import so a
// deploy can move to a newer flash/pro without editing this file.
const PDF_MODEL = Deno.env.get('VIDEO_MODEL') || 'gemini-2.5-flash';

// Test hook — when '1', skip Gemini and read a canned response from the shared
// `ocr_test_fixtures` table keyed by the (normalized) sourceUrl. Mirrors
// video-import's VIDEO_IMPORT_MOCK_MODE. Unset in production.
const MOCK_MODE = Deno.env.get('PDF_IMPORT_MOCK_MODE') === '1';

// Guards: a print-to-PDF recipe is a handful of pages. Cap both the page count
// and the total payload so a runaway upload can't blow the function's memory /
// the model's context. base64 inflates ~33%, so 24 MB ≈ ~18 MB of JPEGs.
const MAX_PAGES = 20;
const MAX_TOTAL_B64_BYTES = 24 * 1024 * 1024;

const SENTRY_DSN = Deno.env.get('SENTRY_DSN');
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: Deno.env.get('SENTRY_RELEASE') ?? undefined,
    environment: Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production',
    // See nutrition/video-import — @sentry/deno can't instrument Deno.serve, so
    // each request gets an explicit scope and the global handlers are disabled.
    defaultIntegrations: false,
    tracesSampleRate: 1.0,
    initialScope: { tags: { component: 'pdf-import' } },
  });
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------- prompt ----------

// Adapted from import-worker's RECIPE_PROMPT (kept field-rule-compatible so
// extraction quality matches the photo OCR flow), but instructs the model to
// merge all pages into ONE recipe and to surface the source URL from the
// print header/footer.
const PDF_EXTRACT_PROMPT = `You are extracting a cooking recipe from the pages of a PDF. The images are consecutive pages of ONE document, IN ORDER — a single recipe may continue across page breaks (ingredients on one page, method on the next). Combine everything into ONE recipe.

Return a JSON object with this structure (valid JSON only, no markdown, no code blocks):
{
  "recipes": [
    {
      "title": "Recipe Title",
      "yield": { "type": "exact", "value": 4.0, "unit": "PEOPLE" },
      "timeEstimate": "30 minutes",
      "equipment": ["stand mixer"],
      "description": "Background text or headnote about the recipe",
      "ingredients": [
        { "type": "measured", "name": "flour", "quantity": { "type": "exact", "value": 250.0, "unit": "GRAM" } },
        { "type": "vague", "name": "salt", "description": "to taste" }
      ],
      "instructions": [
        { "stepNumber": 1, "text": "Mix the flour and salt.", "consumedIngredients": [{ "ingredientName": "flour", "quantity": { "type": "exact", "value": 250.0, "unit": "GRAM" } }, { "ingredientName": "salt", "vague": true }] }
      ]
    }
  ],
  "sourceUrl": "https://… the source URL if it appears in any page header/footer (printed-to-PDF pages usually show it in the footer), else null",
  "rawText": "The full text extracted from all pages"
}

Rules:
- Return exactly ONE recipe in the "recipes" array unless the document clearly contains multiple distinct recipes.
- INGREDIENT TYPE must be exactly "measured" (with quantity) or "vague" (with description). Never use a quantity-type word ("exact"/"fractional"/"range") as the ingredient type.
- QUANTITY TYPES are "exact" ({ value, unit }), "fractional" ({ whole, numerator, denominator, unit }), or "range" ({ min, max, unit }).
- UNITS: CUP, TABLESPOON, TEASPOON, FLUID_OUNCE, OUNCE, POUND, MILLILITER, LITER, DECILITER, GRAM, KILOGRAM, WHOLE, PEOPLE, PINCH, DASH, HANDFUL, TO_TASTE.
- Prefer weight over volume and metric over imperial when both are given.
- temperature: null or { "value": 350, "unit": "FAHRENHEIT" } / "CELSIUS".
- yield uses the PEOPLE unit for serving counts and WHOLE for non-serving yields (cookies, loaves).
- consumedIngredients on each step lists which recipe ingredients are used. For measured items include their quantity; for vague items use { "ingredientName": "...", "vague": true }.
- description: any headnote / intro paragraph about the recipe.
- sourceUrl: read the page header AND footer carefully — print-to-PDF stamps the original web address there. Return it verbatim, or null if none is visible.
- Include the full extracted text in rawText.`;

// ---------- Gemini ----------

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

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

async function callGemini(apiKey: string, parts: GeminiPart[]): Promise<GeminiCallResult> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(PDF_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    temperature: 0,
  };
  const ctrl = new AbortController();
  // Stay under the hosted Edge Function ceiling; a multi-page extraction is
  // well within this.
  const timer = setTimeout(() => ctrl.abort(), 220_000);
  const started = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
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
    throw new HttpError('EXTRACTION_FAILED', `Gemini ${resp.status}: ${rawText.slice(0, 300)}`);
  }
  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(rawText) as GeminiResponse;
  } catch (err) {
    throw new HttpError('EXTRACTION_FAILED', `Gemini response not JSON: ${(err as Error).message}`);
  }
  const cand = parsed.candidates?.[0];
  const text = cand?.content?.parts?.find(
    (p) => typeof p.text === 'string' && p.text.length > 0,
  )?.text;
  if (!text) {
    throw new HttpError(
      'EXTRACTION_FAILED',
      `Gemini returned no text${cand?.finishReason ? ` (${cand.finishReason})` : ''}.`,
    );
  }
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
  if (error) throw new HttpError('EXTRACTION_FAILED', `key lookup: ${error.message}`);
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
// NEVER fail the user's import — swallow everything.
async function recordPdfUsage(
  ownerId: string,
  keyOwnerId: string | null,
  sourceUrl: string | null,
  g: GeminiCallResult,
): Promise<void> {
  try {
    const { error } = await sb.rpc('misc_llm_usage_record', {
      p_event: {
        owner_id: ownerId,
        key_owner_id: keyOwnerId,
        feature: 'pdf',
        provider: 'gemini',
        model: PDF_MODEL,
        prompt_tokens: g.promptTokens,
        completion_tokens: g.completionTokens,
        latency_ms: g.latencyMs,
        error_kind: 'OK',
        produced_ref: sourceUrl,
        produced_kind: 'PDF_IMPORT',
      },
    });
    if (error) console.error('misc_llm_usage_record failed', error.message);
  } catch (err) {
    console.error('misc_llm_usage_record threw', (err as Error).message);
  }
}

// ---------- mock mode (e2e) ----------

async function mockText(sourceUrl: string | null): Promise<string> {
  // Probe (exact sourceUrl) then ('*') wildcard, provider 'gemini' then ''.
  const key = sourceUrl ?? '*';
  const probes = [
    { path: key, provider: 'gemini' },
    { path: key, provider: '' },
    { path: '*', provider: 'gemini' },
    { path: '*', provider: '' },
  ];
  for (const probe of probes) {
    const { data } = await sb
      .from('ocr_test_fixtures')
      .select('response_json, error_kind')
      .eq('item_storage_path', probe.path)
      .eq('provider', probe.provider)
      .eq('model', '')
      .maybeSingle();
    if (data) {
      const row = data as { response_json: unknown; error_kind: string | null };
      if (row.error_kind && row.error_kind !== 'OK') {
        throw new HttpError('EXTRACTION_FAILED', `PDF_IMPORT_MOCK_MODE: forced ${row.error_kind}`);
      }
      return JSON.stringify(row.response_json ?? {});
    }
  }
  throw new HttpError('EXTRACTION_FAILED', `PDF_IMPORT_MOCK_MODE: no fixture for ${key}`);
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

/** Best-effort: derive a per-collection title from the source URL's host, or a
 * generic bucket when there's no URL. Mirrors how link imports group by site. */
function platformTitleFor(sourceUrl: string | null): string {
  if (!sourceUrl) return 'PDF Imports';
  try {
    return new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '') || 'PDF Imports';
  } catch {
    return 'PDF Imports';
  }
}

/** Pull a `sourceUrl` the model may have surfaced from the page header/footer,
 * tolerating snake_case and malformed values. */
function llmSourceUrl(llmText: string): string | null {
  try {
    const obj = JSON.parse(llmText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, ''));
    if (!obj || typeof obj !== 'object') return null;
    const raw = (obj as Record<string, unknown>).sourceUrl ?? (obj as Record<string, unknown>).source_url;
    return typeof raw === 'string' && /^https?:\/\//i.test(raw.trim()) ? raw.trim() : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  return await Sentry.withScope(async () => {
    try {
      return await handle(req);
    } catch (err) {
      if (err instanceof HttpError) {
        if (SENTRY_DSN && err.code === 'EXTRACTION_FAILED') {
          Sentry.captureMessage(`pdf-import ${err.code}: ${err.message}`, {
            level: 'warning',
            tags: { code: err.code },
          });
        }
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

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const pages = Array.isArray(body.pages)
    ? body.pages.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'image/jpeg';
  const requestSourceUrl =
    typeof body.sourceUrl === 'string' && /^https?:\/\//i.test(body.sourceUrl.trim())
      ? body.sourceUrl.trim()
      : null;

  if (pages.length === 0) {
    return json({ error: 'No PDF pages supplied.', code: 'EXTRACTION_FAILED' }, 422);
  }
  if (pages.length > MAX_PAGES) {
    return json(
      { error: `Too many pages (${pages.length}); max ${MAX_PAGES}.`, code: 'EXTRACTION_FAILED' },
      422,
    );
  }
  const totalBytes = pages.reduce((acc, p) => acc + p.length, 0);
  if (totalBytes > MAX_TOTAL_B64_BYTES) {
    return json(
      { error: 'PDF is too large to import in one request.', code: 'EXTRACTION_FAILED' },
      422,
    );
  }

  if (SENTRY_DSN) {
    Sentry.setTag('pages', String(pages.length));
    Sentry.addBreadcrumb({
      category: 'pdf-import',
      level: 'info',
      message: 'received',
      data: { pages: pages.length, hasSourceUrl: !!requestSourceUrl },
    });
  }

  // Resolve the LLM text. In mock mode we short-circuit the Gemini network call.
  let llmText: string;
  if (MOCK_MODE) {
    llmText = await mockText(requestSourceUrl);
  } else if (caller === 'service_role') {
    // A real extraction needs a user's key; service-role callers (tools, tests)
    // should run with PDF_IMPORT_MOCK_MODE instead.
    throw new HttpError('NO_GEMINI_KEY', 'Service-role caller has no user Gemini key.');
  } else {
    const { apiKey, keyOwnerId } = await resolveGeminiKey(caller);
    const parts: GeminiPart[] = [
      { text: PDF_EXTRACT_PROMPT },
      ...pages.map((data) => ({ inline_data: { mime_type: mimeType, data } })),
    ];
    const g = await callGemini(apiKey, parts);
    await recordPdfUsage(caller, keyOwnerId, requestSourceUrl, g);
    llmText = g.text;
  }

  // The client's text-layer extraction is authoritative; the model's read of
  // the header/footer is a fallback.
  const sourceUrl = requestSourceUrl ?? llmSourceUrl(llmText);

  let drafts: ParsedRecipeDraft[];
  try {
    drafts = parseLlmJson(llmText);
  } catch (err) {
    throw new HttpError('EXTRACTION_FAILED', (err as Error).message);
  }
  for (const d of drafts) {
    d.sourceImageText = d.sourceImageText ?? llmText;
  }
  const meaningful = drafts.some(
    (d) => d.title || d.ingredients.length > 0 || d.instructions.length > 0,
  );
  if (!meaningful) {
    return json(
      { error: 'No recipe found in that PDF.', code: 'EXTRACTION_FAILED', sourceUrl },
      422,
    );
  }

  return json({ sourceUrl, platformTitle: platformTitleFor(sourceUrl), drafts });
}
