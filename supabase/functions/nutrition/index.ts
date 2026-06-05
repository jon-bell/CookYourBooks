// Nutrition lookup Edge Function.
//
// Two endpoints:
//   POST /functions/v1/nutrition/search { q: string, limit?: number }
//     → { hits: [{ source, source_id, description, brand?, ... }] }
//     Queries USDA FoodData Central by name, falls back to Open Food
//     Facts when USDA returns nothing useful. Caches each hit in
//     `nutrition_facts_cache` before returning.
//
//   POST /functions/v1/nutrition/get { source: string, source_id: string }
//     → cached row, fetching + caching if missing.
//
// USDA key is read from Vault (`nutrition_worker_config.usda_fdc_key`)
// so it never reaches the browser bundle. Open Food Facts has no key.
//
// Same auth posture as import-worker: requires an authenticated JWT or
// a service-role token. The data is public domain (USDA) / ODbL (OFF),
// but the rate budget is a shared resource — we don't want unauth
// callers consuming it.

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import * as Sentry from 'https://esm.sh/@sentry/deno@9.46.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Self-hosted Sentry. Both Deno edge functions report to the shared
// `cyb-deno` project via the single `SENTRY_DSN` secret (edge-function
// secrets are global to the Supabase project). Nothing is baked in, so
// an unset secret = clean no-op.
const SENTRY_DSN = Deno.env.get('SENTRY_DSN');
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: Deno.env.get('SENTRY_RELEASE') ?? undefined,
    environment: Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production',
    // @sentry/deno can't instrument Deno.serve, so a warm isolate shares
    // one global scope across requests. Disable the default integrations
    // (auto global error/breadcrumb handlers) to stop one request's
    // context bleeding into the next; each request is scoped explicitly
    // via Sentry.withScope below. Trade-off: no automatic tracing spans.
    defaultIntegrations: false,
    tracesSampleRate: 1.0,
    initialScope: { tags: { component: 'nutrition' } },
  });
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------- Normalized response shape ----------

interface CachedFact {
  source: 'USDA_FDC' | 'OPEN_FOOD_FACTS';
  source_id: string;
  description: string;
  brand: string | null;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  saturated_fat_g: number | null;
  carbs_g: number | null;
  sugar_g: number | null;
  fiber_g: number | null;
  sodium_mg: number | null;
  portions: { unit: string; grams: number }[];
}

// ---------- USDA (via local snapshot) ----------
//
// We no longer hit USDA's HTTP API per query. The full Foundation,
// SR Legacy, Survey (FNDDS), and Branded datasets are loaded into
// `nutrition_foods_master` by `scripts/load-usda-foods.ts` and served
// from there. `search_nutrition_foods` does the FTS + tier-sort
// server-side so the function just shapes rows for the client.
//
// Removed:
//   - getUsdaKey() / vault lookup    — no API key needed
//   - usdaSearch over HTTP            — replaced by RPC
//   - nutrientsPer100g / portions     — done at load time, stored
//   - USDA_PRIORITY                   — pushed into the RPC's ORDER BY

interface MasterRow {
  source: string;
  source_id: string;
  data_type: string;
  description: string;
  brand: string | null;
  brand_owner: string | null;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  saturated_fat_g: number | null;
  carbs_g: number | null;
  sugar_g: number | null;
  fiber_g: number | null;
  sodium_mg: number | null;
  portions: { unit: string; grams: number }[];
}

// Strip recipe-ese that confuses the FTS matcher without changing the
// nutritional identity. Removes parentheticals ("(chopped)"), trailing
// prep notes after a comma (", diced", ", to taste"), and surrounding
// punctuation. Nutrition-relevant modifiers (raw vs cooked, whole-wheat
// vs all-purpose, low-fat vs full-fat) pass through unchanged.
function normalizeForSearch(q: string): string {
  return q
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/,.*$/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.-]+|[\s"'.-]+$/g, '')
    .trim();
}

async function masterSearch(q: string, limit: number): Promise<CachedFact[]> {
  const normalized = normalizeForSearch(q);
  if (!normalized) return [];
  const { data, error } = await sb.rpc('search_nutrition_foods', {
    p_query: normalized,
    p_limit: limit,
  });
  if (error) throw new Error(`master search: ${error.message}`);
  if (!Array.isArray(data)) return [];
  return (data as MasterRow[]).map((r) => ({
    source: r.source as CachedFact['source'],
    source_id: r.source_id,
    description: r.description,
    // brand is the most user-meaningful label; brand_owner is the
    // parent company (often less recognizable). Prefer the former.
    brand: r.brand ?? r.brand_owner ?? null,
    calories_kcal: r.calories_kcal,
    protein_g: r.protein_g,
    fat_g: r.fat_g,
    saturated_fat_g: r.saturated_fat_g,
    carbs_g: r.carbs_g,
    sugar_g: r.sugar_g,
    fiber_g: r.fiber_g,
    sodium_mg: r.sodium_mg,
    portions: Array.isArray(r.portions) ? r.portions : [],
  }));
}

// ---------- Open Food Facts ----------

interface OffProduct {
  code: string;
  product_name?: string;
  brands?: string;
  nutriments?: Record<string, number | string>;
  serving_size?: string;
  serving_quantity?: number;
}

async function offSearch(q: string, limit: number): Promise<OffProduct[]> {
  // The v2 search API ranks by popularity; good enough as a fallback.
  const url = new URL('https://world.openfoodfacts.org/api/v2/search');
  url.searchParams.set('search_terms', q);
  url.searchParams.set('page_size', String(Math.min(limit, 25)));
  url.searchParams.set(
    'fields',
    'code,product_name,brands,nutriments,serving_size,serving_quantity',
  );
  const resp = await fetch(url.toString(), {
    headers: {
      // OFF's anon rate-limit pool is aggressive and frequently 503s.
      // They want AppName/Version (contact) so they can reach a human.
      'User-Agent': 'CookYourBooks/1.0 (jon@jonbell.net)',
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    // 429 / 5xx is OFF being unhappy with anon traffic; treat as "no
    // hits" rather than throwing — the caller's already got nothing
    // from USDA and a thrown error just spams the console with a
    // 5KB HTML rate-limit page.
    if (resp.status === 429 || resp.status >= 500) {
      console.warn(`OFF unavailable (${resp.status}); returning no hits`);
      return [];
    }
    const text = await resp.text();
    throw new Error(`OFF search ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { products?: OffProduct[] };
  return (json.products ?? []).filter((p) => p.product_name && p.nutriments);
}

function offNumber(
  nut: Record<string, number | string> | undefined,
  ...keys: string[]
): number | null {
  if (!nut) return null;
  for (const k of keys) {
    const v = nut[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function offToCache(p: OffProduct): CachedFact {
  // OFF reports per-100g via `_100g` suffix.
  const n = p.nutriments ?? {};
  return {
    source: 'OPEN_FOOD_FACTS',
    source_id: p.code,
    description: p.product_name ?? 'Unnamed product',
    brand: p.brands ?? null,
    calories_kcal: offNumber(n, 'energy-kcal_100g', 'energy-kcal'),
    protein_g: offNumber(n, 'proteins_100g', 'proteins'),
    fat_g: offNumber(n, 'fat_100g', 'fat'),
    saturated_fat_g: offNumber(n, 'saturated-fat_100g', 'saturated-fat'),
    carbs_g: offNumber(n, 'carbohydrates_100g', 'carbohydrates'),
    sugar_g: offNumber(n, 'sugars_100g', 'sugars'),
    fiber_g: offNumber(n, 'fiber_100g', 'fiber'),
    sodium_mg:
      offNumber(n, 'sodium_100g', 'sodium') == null
        ? null
        : (offNumber(n, 'sodium_100g', 'sodium') as number) * 1000,
    portions: [],
  };
}

// ---------- Caching ----------

async function persist(facts: CachedFact[]): Promise<void> {
  if (facts.length === 0) return;
  const rows = facts.map((f) => ({
    source: f.source,
    source_id: f.source_id,
    description: f.description,
    brand: f.brand,
    calories_kcal: f.calories_kcal,
    protein_g: f.protein_g,
    fat_g: f.fat_g,
    saturated_fat_g: f.saturated_fat_g,
    carbs_g: f.carbs_g,
    sugar_g: f.sugar_g,
    fiber_g: f.fiber_g,
    sodium_mg: f.sodium_mg,
    portions: f.portions,
    fetched_at: new Date().toISOString(),
  }));
  const { error } = await sb
    .from('nutrition_facts_cache')
    .upsert(rows, { onConflict: 'source,source_id' });
  if (error) console.error('nutrition cache upsert', error);
}

async function lookupCached(
  source: CachedFact['source'],
  sourceId: string,
): Promise<CachedFact | null> {
  const { data, error } = await sb
    .from('nutrition_facts_cache')
    .select('*')
    .eq('source', source)
    .eq('source_id', sourceId)
    .maybeSingle();
  if (error || !data) return null;
  return data as CachedFact;
}

// ---------- HTTP handler ----------

// Called directly from the browser (unlike import-worker, which is
// reached server-side via pg_net), so we need to answer preflights and
// echo CORS headers on every response.
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
  // Service role JWT short-circuits the user lookup.
  if (token === SERVICE_ROLE_KEY) return 'service_role';
  // Validate the user JWT against the anon-key-clientside session
  // verification path.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

Deno.serve(async (req) => {
  // Isolate Sentry scope per request — Deno.serve isn't instrumented by
  // the SDK, so a reused warm isolate would otherwise share scope across
  // requests. withScope discards the child scope when the callback ends.
  return await Sentry.withScope(async () => {
    try {
      return await handle(req);
    } catch (err) {
      if (SENTRY_DSN) Sentry.captureException(err);
      console.error('unhandled invocation error', err);
      return json({ error: 'internal' }, 500);
    } finally {
      // Flush before the isolate freezes on return — otherwise the async
      // transport is killed mid-POST and events (including the per-stage
      // captureException calls in `handle`, which fire on 200 responses)
      // never reach Sentry. No-ops when Sentry was never initialized.
      if (SENTRY_DSN) await Sentry.flush(2000);
    }
  });
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/+nutrition\/?/, '/').replace(/^\/+/, '/');

  const caller = await requireAuth(req);
  if (!caller) return json({ error: 'unauthorized' }, 401);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (path === '/search' || path === '/' || path === '') {
    const q = typeof body.q === 'string' ? body.q.trim() : '';
    const limit = typeof body.limit === 'number' ? body.limit : 10;
    if (!q) return json({ hits: [] });

    const facts: CachedFact[] = [];
    try {
      const hits = await masterSearch(q, limit);
      console.log(`master search "${q}" → ${hits.length} hits`);
      facts.push(...hits);
    } catch (e) {
      console.error('master search failed', e);
      Sentry.captureException(e, { tags: { stage: 'master_search' }, extra: { q } });
    }
    if (facts.length === 0) {
      try {
        const products = await offSearch(q, limit);
        console.log(`OFF search "${q}" → ${products.length} hits`);
        for (const p of products) facts.push(offToCache(p));
      } catch (e) {
        console.error('OFF search failed', e);
        Sentry.captureException(e, { tags: { stage: 'off_search' }, extra: { q } });
      }
    }
    await persist(facts);
    return json({ hits: facts.slice(0, limit) });
  }

  if (path === '/get') {
    const source = body.source as CachedFact['source'];
    const sourceId = body.source_id as string;
    if (!source || !sourceId) return json({ error: 'missing source / source_id' }, 400);
    const cached = await lookupCached(source, sourceId);
    return json({ fact: cached });
  }

  return json({ error: 'not found' }, 404);
}
