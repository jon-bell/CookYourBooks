// Video-link recipe import Edge Function.
//
//   POST /functions/v1/video-import { url: string, caption?: string }
//     → { platform, sourceUrl, drafts: ParsedRecipeDraft[] }
//
// Extracts a recipe from a pasted social-video link, synchronously:
//   - YouTube  → Gemini "watches" the video natively (file_data fileUri).
//   - TikTok   → caption/title via tokenless oEmbed → Gemini text extract.
//   - Instagram→ caption via Graph oEmbed (IG_OEMBED_TOKEN) if configured,
//                else the client supplies `caption` (NEEDS_CAPTION).
//
// The user's own Gemini key is read from Vault via the `ocr_resolve_key`
// RPC (same mechanism the OCR import-worker uses) so it never reaches the
// browser bundle. Same auth posture as nutrition / import-worker: an
// authenticated JWT or a service-role token.
//
// Errors carry a machine-readable `code` so the UI can react:
//   NO_GEMINI_KEY · UNSUPPORTED_URL · NEEDS_CAPTION · EXTRACTION_FAILED

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import * as Sentry from 'https://esm.sh/@sentry/deno@9.46.0';
import { parseLlmJson, type ParsedRecipeDraft } from './parser.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Video-capable Gemini model. Overridable so a deploy can move to a newer
// flash/pro without editing this file. Flash is the right cost/latency tier
// for recipe extraction.
const VIDEO_MODEL = Deno.env.get('VIDEO_MODEL') || 'gemini-2.5-flash';

// Test hook — when '1', skip Gemini/oEmbed and read a canned response from
// the shared `ocr_test_fixtures` table keyed by the (normalized) URL.
// Mirrors import-worker's OCR_MOCK_MODE. Unset in production.
const MOCK_MODE = Deno.env.get('VIDEO_IMPORT_MOCK_MODE') === '1';

// Optional Facebook app token for Instagram Graph oEmbed (caption fetch).
// Without it, Instagram falls back to a client-supplied caption.
const IG_OEMBED_TOKEN = Deno.env.get('IG_OEMBED_TOKEN');

const SENTRY_DSN = Deno.env.get('SENTRY_DSN');
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: Deno.env.get('SENTRY_RELEASE') ?? undefined,
    environment: Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production',
    // See nutrition/index.ts — @sentry/deno can't instrument Deno.serve, so
    // each request gets an explicit scope and the default global handlers
    // are disabled to stop scope bleeding across a warm isolate.
    defaultIntegrations: false,
    tracesSampleRate: 1.0,
    initialScope: { tags: { component: 'video-import' } },
  });
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------- platform detection ----------

export type Platform = 'youtube' | 'tiktok' | 'instagram';

/** Human-facing collection title per platform (also the find-or-create key). */
const PLATFORM_TITLE: Record<Platform, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
};

export function detectPlatform(url: string): Platform | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    return 'youtube';
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  return null;
}

// ---------- extraction prompt ----------

// Same JSON contract the OCR parser expects (see import-worker/parser.ts).
// Worded for a cooking video / its caption rather than a photographed page.
const VIDEO_EXTRACT_PROMPT = `You are extracting a cooking recipe from a social-media video (or its caption).
Return ONLY a JSON object of the form { "recipes": [ ... ] }. Each recipe object:
{
  "title": string,
  "description": string,                // headnote / intro, optional
  "timeEstimate": string,               // free text, optional
  "servings": { "amount": number, "description"?: string, "amountMax"?: number },
  "equipment": string[],                // optional
  "ingredients": [
    { "type": "measured", "name": string,
      "quantity": { "type": "exact", "value": number, "unit": string } | { "type": "fractional", "whole": number, "numerator": number, "denominator": number, "unit": string } | { "type": "range", "min": number, "max": number, "unit": string },
      "preparation"?: string, "notes"?: string },
    { "type": "vague", "name": string, "description"?: string }   // e.g. "salt to taste"
  ],
  "instructions": [
    { "stepNumber": number, "text": string,
      "temperature"?: { "value": number, "unit": "FAHRENHEIT" | "CELSIUS" },
      "consumedIngredients"?: [ { "ingredientName": string } ] }
  ]
}
Rules:
- Transcribe quantities and units exactly as stated. Use plain unit names ("cup", "gram", "tablespoon").
- If a quantity is unclear or absent, emit a "vague" ingredient instead of guessing numbers.
- Preserve every distinct step in order. Do not invent steps, ingredients, or amounts.
- If the source is not a recipe, return { "recipes": [] }.`;

// ---------- Gemini ----------

interface GeminiPart {
  text?: string;
  file_data?: { file_uri: string; mime_type?: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { code?: number; message?: string };
}

async function callGemini(
  apiKey: string,
  parts: GeminiPart[],
  opts: { lowMediaResolution?: boolean } = {},
): Promise<string> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(VIDEO_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    temperature: 0,
  };
  // Video is tokenized at ~300 tok/s by default; LOW (~100 tok/s) is plenty
  // for reading on-screen recipe content and ~3× cheaper.
  if (opts.lowMediaResolution) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';

  const ctrl = new AbortController();
  // Stay under the hosted Edge Function ceiling; Gemini reads a short reel
  // in well under this.
  const timer = setTimeout(() => ctrl.abort(), 220_000);
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
  return text;
}

// ---------- oEmbed caption fetch ----------

async function fetchTikTokCaption(url: string): Promise<string | undefined> {
  const oembed = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const resp = await fetch(oembed, { headers: { Accept: 'application/json' } });
  if (!resp.ok) return undefined;
  const json = (await resp.json().catch(() => null)) as
    | { title?: string; author_name?: string }
    | null;
  if (!json) return undefined;
  return [json.title, json.author_name ? `by ${json.author_name}` : undefined]
    .filter(Boolean)
    .join('\n');
}

async function fetchInstagramCaption(url: string): Promise<string | undefined> {
  if (!IG_OEMBED_TOKEN) return undefined;
  const oembed =
    `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}` +
    `&access_token=${encodeURIComponent(IG_OEMBED_TOKEN)}`;
  const resp = await fetch(oembed, { headers: { Accept: 'application/json' } });
  if (!resp.ok) return undefined;
  const json = (await resp.json().catch(() => null)) as
    | { title?: string; author_name?: string }
    | null;
  if (!json) return undefined;
  return [json.title, json.author_name ? `by ${json.author_name}` : undefined]
    .filter(Boolean)
    .join('\n');
}

// ---------- mock mode ----------

async function mockText(url: string): Promise<string> {
  // Probe (exact url) then ('*') wildcard, provider 'gemini' then ''.
  const probes = [
    { path: url, provider: 'gemini' },
    { path: url, provider: '' },
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
        throw new HttpError('EXTRACTION_FAILED', `VIDEO_IMPORT_MOCK_MODE: forced ${row.error_kind}`);
      }
      return JSON.stringify(row.response_json ?? {});
    }
  }
  throw new HttpError('EXTRACTION_FAILED', `VIDEO_IMPORT_MOCK_MODE: no fixture for ${url}`);
}

// ---------- key resolution ----------

async function resolveGeminiKey(ownerId: string): Promise<string> {
  const { data, error } = await sb.rpc('ocr_resolve_key', {
    p_owner_id: ownerId,
    p_provider: 'gemini',
  });
  if (error) throw new HttpError('EXTRACTION_FAILED', `key lookup: ${error.message}`);
  const row = Array.isArray(data) ? (data[0] as { api_key?: string } | undefined) : undefined;
  if (!row?.api_key) {
    throw new HttpError('NO_GEMINI_KEY', 'No Gemini API key configured for this user.');
  }
  return row.api_key;
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

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
  if (!url) return json({ error: 'missing url', code: 'UNSUPPORTED_URL' }, 400);

  const platform = detectPlatform(url);
  if (!platform) {
    return json(
      { error: 'Only YouTube, TikTok, and Instagram links are supported.', code: 'UNSUPPORTED_URL' },
      400,
    );
  }

  const needsCaption = () =>
    json(
      {
        error: 'Could not read the caption. Paste the recipe caption to continue.',
        code: 'NEEDS_CAPTION',
        platform,
        sourceUrl: url,
      },
      422,
    );

  // For the text-based platforms (TikTok / Instagram) resolve the caption
  // up front — this is also where the NEEDS_CAPTION decision lives, and it
  // doesn't depend on the LLM, so it runs the same in mock mode (minus the
  // oEmbed network call).
  let captionText: string | undefined;
  if (platform !== 'youtube') {
    if (MOCK_MODE) {
      // Skip oEmbed; Instagram-with-no-token still needs a client caption.
      if (platform === 'instagram' && !IG_OEMBED_TOKEN && !caption) return needsCaption();
      captionText = caption || 'mock caption';
    } else {
      const fetched =
        platform === 'tiktok'
          ? await fetchTikTokCaption(url)
          : ((await fetchInstagramCaption(url)) ?? (caption || undefined));
      captionText = (fetched ?? (caption || '')).trim() || undefined;
      if (!captionText) return needsCaption();
    }
  }

  // Resolve LLM text. In mock mode we short-circuit the Gemini network call.
  let llmText: string;
  if (MOCK_MODE) {
    llmText = await mockText(url);
  } else if (caller === 'service_role') {
    // A real extraction needs a user's key; service-role callers (tools,
    // tests) should run with VIDEO_IMPORT_MOCK_MODE instead.
    throw new HttpError('NO_GEMINI_KEY', 'Service-role caller has no user Gemini key.');
  } else {
    const apiKey = await resolveGeminiKey(caller);
    llmText =
      platform === 'youtube'
        ? await callGemini(
            apiKey,
            [{ text: VIDEO_EXTRACT_PROMPT }, { file_data: { file_uri: url } }],
            { lowMediaResolution: true },
          )
        : await callGemini(apiKey, [
            { text: `${VIDEO_EXTRACT_PROMPT}\n\nVIDEO CAPTION:\n${captionText}` },
          ]);
  }

  let drafts: ParsedRecipeDraft[];
  try {
    drafts = parseLlmJson(llmText);
  } catch (err) {
    throw new HttpError('EXTRACTION_FAILED', (err as Error).message);
  }
  // Record provenance + a friendlier collection title hint on each draft.
  for (const d of drafts) {
    d.sourceImageText = d.sourceImageText ?? llmText;
  }
  const meaningful = drafts.some(
    (d) => d.title || d.ingredients.length > 0 || d.instructions.length > 0,
  );
  if (!meaningful) {
    return json(
      { error: 'No recipe found in that video.', code: 'EXTRACTION_FAILED', platform, sourceUrl: url },
      422,
    );
  }

  return json({ platform, platformTitle: PLATFORM_TITLE[platform], sourceUrl: url, drafts });
}
