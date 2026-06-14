// OCR key validation Edge Function.
//
//   POST /functions/v1/ocr-key-test { provider, apiKey, baseUrl?, model? }
//     → { ok: true }
//     → { ok: false, reason: 'auth' | 'network' | 'other', message }
//
// Lets the onboarding wizard confirm a freshly-pasted key actually works
// *before* it's stored in Vault, so non-technical users catch typos / wrong
// keys immediately instead of on their first failed import. The key is supplied
// in the request (not yet stored), so this function never touches Vault.
//
// Validation is a free, zero-token call:
//   - gemini             → GET generativelanguage…/v1beta/models?key=<key>
//   - openai-compatible  → GET <baseUrl>/models  (Authorization: Bearer <key>)
//
// Same auth posture as nutrition / video-import: an authenticated user JWT or
// the service-role key. verify_jwt is off in config.toml so the CORS preflight
// reaches the function; requireAuth() does the real check.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Test hook — when '1', skip the real provider call. The sentinel key
// 'cyb-test-valid-key' validates; anything else returns an auth failure.
// Mirrors import-worker's OCR_MOCK_MODE. Unset in production.
const MOCK_MODE = Deno.env.get('OCR_KEY_TEST_MOCK') === '1';
const MOCK_VALID_KEY = 'cyb-test-valid-key';

// Keep the validation snappy — a hung provider shouldn't hang the wizard.
const FETCH_TIMEOUT_MS = 10_000;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Max-Age': '86400',
};

type Provider = 'gemini' | 'openai-compatible';
type Reason = 'auth' | 'network' | 'other';

interface TestResult {
  ok: boolean;
  reason?: Reason;
  message?: string;
}

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

// Maps the provider's HTTP status to the wizard's three plain-language buckets.
// Unlike import-worker/ocr.ts classifyHttp (which only treats 401/403 as AUTH),
// a *validation* call folds 400 into 'auth': Gemini rejects an invalid key with
// 400 INVALID_ARGUMENT / API_KEY_INVALID, and the models.list GET has no request
// body to otherwise trigger a 400 — so a 400 here means "bad key", which is
// exactly the typo case the friendly "that key didn't work" message is for.
function classifyStatus(status: number): Reason {
  if (status === 400 || status === 401 || status === 403) return 'auth';
  if (status >= 500 && status < 600) return 'network';
  return 'other';
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function testKey(
  provider: Provider,
  apiKey: string,
  baseUrl?: string,
): Promise<TestResult> {
  if (MOCK_MODE) {
    return apiKey === MOCK_VALID_KEY
      ? { ok: true }
      : { ok: false, reason: 'auth', message: 'mock: invalid key' };
  }

  try {
    let resp: Response;
    if (provider === 'gemini') {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      resp = await fetchWithTimeout(url, { method: 'GET' });
    } else {
      const base = (baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '');
      resp = await fetchWithTimeout(`${base}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    }

    if (resp.ok) return { ok: true };
    // Drain the body so the message can carry a short hint, but cap it.
    const text = (await resp.text().catch(() => '')).slice(0, 300);
    return { ok: false, reason: classifyStatus(resp.status), message: text || `HTTP ${resp.status}` };
  } catch (err) {
    // AbortError (timeout) or a DNS/connection failure — both are "couldn't
    // reach the provider", which the wizard phrases as a network problem.
    return { ok: false, reason: 'network', message: (err as Error).message };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const caller = await requireAuth(req);
  if (!caller) return json({ error: 'unauthorized' }, 401);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = body.provider === 'openai-compatible' ? 'openai-compatible' : 'gemini';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : undefined;
  if (!apiKey) {
    return json({ ok: false, reason: 'auth', message: 'No key provided' } satisfies TestResult);
  }

  const result = await testKey(provider as Provider, apiKey, baseUrl);
  return json(result satisfies TestResult);
});
