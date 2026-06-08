// Video-link recipe import Edge Function.
//
//   POST /functions/v1/video-import { url: string, caption?: string }
//     → { platform, sourceUrl, drafts: ParsedRecipeDraft[] }
//
// Extracts a recipe from a pasted link, synchronously:
//   - YouTube  → Gemini "watches" the video natively (file_data fileUri).
//   - TikTok   → caption/title via tokenless oEmbed → Gemini text extract.
//   - Instagram→ caption via Graph oEmbed (IG_OEMBED_TOKEN) if configured,
//                else the client supplies `caption` (NEEDS_CAPTION).
//   - website  → any other http(s) URL: fetch the page, read schema.org
//                Recipe JSON-LD if present (free, exact), else fall back to
//                Gemini over the page text. See jsonld.ts.
//
// The user's own Gemini key (or a borrowed household key) is read from Vault
// via the `ocr_resolve_effective_key` RPC (same mechanism the OCR
// import-worker uses) so it never reaches the browser bundle. Same auth
// posture as nutrition / import-worker: an authenticated JWT or a
// service-role token. Each real Gemini call's token usage is metered into the
// LLM Cost Center via misc_llm_usage_record (best-effort; the free JSON-LD
// path and mock mode are not metered).
//
// Errors carry a machine-readable `code` so the UI can react:
//   NO_GEMINI_KEY · UNSUPPORTED_URL · NEEDS_CAPTION · EXTRACTION_FAILED

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import * as Sentry from 'https://esm.sh/@sentry/deno@9.46.0';
import { parseLlmJson, type ParsedRecipeDraft } from './parser.ts';
import { extractJsonLdRecipes, extractSiteName, schemaRecipeToContract } from './jsonld.ts';

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

export type Platform = 'youtube' | 'tiktok' | 'instagram' | 'website';

/** Human-facing collection title for the social platforms (the find-or-create
 * key). 'website' titles are derived per-domain from the page itself. */
const SOCIAL_TITLE: Record<'youtube' | 'tiktok' | 'instagram', string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
};

/**
 * Classify a pasted URL. Recognized social platforms get their dedicated
 * extraction path; any other http(s) URL is treated as a generic recipe
 * website. Returns null only for input that isn't an http(s) URL at all.
 */
export function detectPlatform(url: string): Platform | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    return 'youtube';
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  return 'website';
}

// ---------- generic website fetch ----------

// Block server-side requests to private / loopback / link-local hosts so a
// pasted URL can't be used to probe internal services (SSRF). Hostname-based;
// pairs with `redirect: 'manual'` so we don't follow a public→private bounce.
function isSafePublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host.endsWith('.internal')) return false;
  // Raw IPv4 in a private / loopback / link-local / metadata range.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
  }
  // IPv6 loopback / unique-local / link-local.
  if (host === '[::1]' || host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80')) {
    return false;
  }
  return true;
}

async function fetchPageHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        // Some sites 403 a bare fetch; a desktop UA gets the article HTML.
        'User-Agent':
          'Mozilla/5.0 (compatible; CookYourBooks/1.0; +https://cookyourbooks.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new HttpError('EXTRACTION_FAILED', `Could not fetch the page: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  // A redirect to a private host would dodge the SSRF check, so refuse to follow.
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get('location');
    if (loc && isSafePublicHttpUrl(new URL(loc, url).toString())) {
      return fetchPageHtml(new URL(loc, url).toString());
    }
    throw new HttpError('EXTRACTION_FAILED', 'The link redirected somewhere we can\'t fetch.');
  }
  if (!resp.ok) throw new HttpError('EXTRACTION_FAILED', `Page returned ${resp.status}.`);
  // Cap the body so a giant page can't blow the isolate's memory / token budget.
  const raw = await resp.text();
  return raw.slice(0, 2_000_000);
}

/** Strip a page to readable text for the LLM fallback (no JSON-LD found). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24_000);
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

// Website fallback: the page is a blog post / article that mixes a recipe in
// with story, comments, and ads. Same JSON contract; just reframed for prose.
const WEBSITE_EXTRACT_PROMPT = VIDEO_EXTRACT_PROMPT.replace(
  'a social-media video (or its caption)',
  'a recipe web page (which also contains unrelated story text, comments, and navigation)',
);

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
  parts: GeminiPart[],
  opts: { lowMediaResolution?: boolean } = {},
): Promise<GeminiCallResult> {
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
// NEVER fail the user's import — swallow everything. Only the real-Gemini
// paths call this; the free JSON-LD path and mock mode never reach it.
async function recordVideoUsage(
  ownerId: string,
  keyOwnerId: string | null,
  sourceUrl: string,
  g: GeminiCallResult,
): Promise<void> {
  try {
    const { error } = await sb.rpc('misc_llm_usage_record', {
      p_event: {
        owner_id: ownerId,
        key_owner_id: keyOwnerId,
        feature: 'video',
        provider: 'gemini',
        model: VIDEO_MODEL,
        prompt_tokens: g.promptTokens,
        completion_tokens: g.completionTokens,
        latency_ms: g.latencyMs,
        error_kind: 'OK',
        produced_ref: sourceUrl,
        produced_kind: 'VIDEO_URL',
      },
    });
    if (error) console.error('misc_llm_usage_record failed', error.message);
  } catch (err) {
    console.error('misc_llm_usage_record threw', (err as Error).message);
  }
}

// callGemini + best-effort metering in one step, so every real Gemini call
// site records uniformly.
async function callGeminiMetered(
  apiKey: string,
  keyOwnerId: string | null,
  ownerId: string,
  sourceUrl: string,
  parts: GeminiPart[],
  opts: { lowMediaResolution?: boolean } = {},
): Promise<string> {
  const g = await callGemini(apiKey, parts, opts);
  await recordVideoUsage(ownerId, keyOwnerId, sourceUrl, g);
  return g.text;
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
    return json({ error: 'Paste a valid http(s) recipe link.', code: 'UNSUPPORTED_URL' }, 400);
  }

  // Resolve the LLM text and the per-collection title. Each platform fills
  // these in its own way; the shared tail below parses + returns them.
  let llmText: string;
  let platformTitle: string;

  if (platform === 'website') {
    ({ llmText, platformTitle } = await extractWebsite(url, caller));
  } else {
    platformTitle = SOCIAL_TITLE[platform];

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
    if (MOCK_MODE) {
      llmText = await mockText(url);
    } else if (caller === 'service_role') {
      // A real extraction needs a user's key; service-role callers (tools,
      // tests) should run with VIDEO_IMPORT_MOCK_MODE instead.
      throw new HttpError('NO_GEMINI_KEY', 'Service-role caller has no user Gemini key.');
    } else {
      const { apiKey, keyOwnerId } = await resolveGeminiKey(caller);
      llmText =
        platform === 'youtube'
          ? await callGeminiMetered(
              apiKey,
              keyOwnerId,
              caller,
              url,
              [{ text: VIDEO_EXTRACT_PROMPT }, { file_data: { file_uri: url } }],
              { lowMediaResolution: true },
            )
          : await callGeminiMetered(apiKey, keyOwnerId, caller, url, [
              { text: `${VIDEO_EXTRACT_PROMPT}\n\nVIDEO CAPTION:\n${captionText}` },
            ]);
    }
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
    const where = platform === 'website' ? 'on that page' : 'in that video';
    return json(
      { error: `No recipe found ${where}.`, code: 'EXTRACTION_FAILED', platform, sourceUrl: url },
      422,
    );
  }

  return json({ platform, platformTitle, sourceUrl: url, drafts });
}

/**
 * Generic recipe-website extraction. Tries schema.org/Recipe JSON-LD first
 * (free, exact, no LLM); falls back to feeding the page's text to Gemini.
 * Returns the LLM-contract text the shared tail parses, plus a per-domain
 * collection title.
 */
async function extractWebsite(
  url: string,
  caller: string,
): Promise<{ llmText: string; platformTitle: string }> {
  if (MOCK_MODE) {
    // Tests register a fixture keyed by URL (recipe JSON), same as social.
    return { llmText: await mockText(url), platformTitle: extractSiteName('', url) };
  }
  if (!isSafePublicHttpUrl(url)) {
    throw new HttpError('UNSUPPORTED_URL', 'That host is not reachable.');
  }

  const html = await fetchPageHtml(url);
  const platformTitle = extractSiteName(html, url);

  const recipes = extractJsonLdRecipes(html);
  if (recipes.length > 0) {
    return { llmText: JSON.stringify({ recipes: recipes.map(schemaRecipeToContract) }), platformTitle };
  }

  // No structured recipe on the page — fall back to the LLM over page text.
  if (caller === 'service_role') {
    throw new HttpError('NO_GEMINI_KEY', 'Service-role caller has no user Gemini key.');
  }
  const { apiKey, keyOwnerId } = await resolveGeminiKey(caller);
  const text = htmlToText(html);
  const llmText = await callGeminiMetered(apiKey, keyOwnerId, caller, url, [
    { text: `${WEBSITE_EXTRACT_PROMPT}\n\nPAGE TEXT:\n${text}` },
  ]);
  return { llmText, platformTitle };
}
