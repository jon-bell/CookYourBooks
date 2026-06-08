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
import { extractIngredientTerms, ingredientSearchQuery } from './_ingredientTerms.ts';

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

// Term extraction (parenthetical / prep / alternative-list / size-word
// stripping, keeping nutrition-relevant modifiers) lives in the shared
// `_ingredientTerms.ts`, a byte-for-byte port of the domain helper so
// the edge function, the browser local search, and the recipe-nutrition
// hook all normalize identically.

async function masterSearch(
  q: string,
  limit: number,
  genericOnly: boolean,
): Promise<CachedFact[]> {
  const normalized = ingredientSearchQuery(q);
  if (!normalized) return [];
  const { data, error } = await sb.rpc('search_nutrition_foods', {
    p_query: normalized,
    p_limit: limit,
    p_generic_only: genericOnly,
  });
  if (error) throw new Error(`master search: ${error.message}`);
  if (!Array.isArray(data)) return [];
  return (data as MasterRow[]).map(masterRowToFact);
}

function masterRowToFact(r: MasterRow): CachedFact {
  return {
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
  };
}

// ---------- Semantic fallback (gte-small over generic foods) ----------
//
// When lexical search whiffs (e.g. "neutral oil" — no row literally says
// "neutral"), embed the query with the same gte-small model used for
// recipe search and cosine-match against the pre-embedded generic foods
// (nutrition_food_embeddings, 20260608000500). Runs through the Edge
// Runtime's native Supabase.ai session — transformers.js has no working
// ONNX backend here. Keep the model id in lockstep with
// packages/domain/src/services/embeddingModel.ts (EMBEDDING_STORED_MODEL)
// and supabase/functions/import-worker/embed.ts.
const GTE_SESSION_MODEL = 'gte-small';
const EMBEDDING_DIM = 384;

type AiSession = {
  run(
    input: string,
    opts?: { mean_pool?: boolean; normalize?: boolean },
  ): Promise<number[] | Float32Array>;
};
declare const Supabase: { ai: { Session: new (model: string) => AiSession } };

let sessionSingleton: AiSession | undefined;
function getSession(): AiSession {
  if (!sessionSingleton) {
    sessionSingleton = new Supabase.ai.Session(GTE_SESSION_MODEL);
  }
  return sessionSingleton;
}

/** Lexical result is "weak" if there's nothing, or the top hit doesn't
 *  even mention the query's head food noun (so it's probably a token
 *  coincidence, not a real match). */
function lexicalIsWeak(q: string, facts: CachedFact[]): boolean {
  if (facts.length === 0) return true;
  const core = extractIngredientTerms(q).core[0];
  if (!core) return false;
  const top = (facts[0]?.description ?? '').toLowerCase();
  // Stem-tolerant-ish: match the core noun as a prefix so "tomatoes"
  // covers "tomato". Cheap and good enough as a fallback trigger.
  const stem = core.length > 4 ? core.slice(0, core.length - 1) : core;
  return !top.includes(stem);
}

async function semanticSearch(q: string, limit: number): Promise<CachedFact[]> {
  const text = ingredientSearchQuery(q) || q;
  if (!text) return [];
  const session = getSession();
  const res = await session.run(text, { mean_pool: true, normalize: true });
  const vec = res instanceof Float32Array ? Array.from(res) : (res as number[]);
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`semantic search: expected ${EMBEDDING_DIM}-dim vector, got ${vec.length}`);
  }
  const { data, error } = await sb.rpc('search_nutrition_foods_semantic', {
    p_embedding: vec,
    p_limit: limit,
  });
  if (error) throw new Error(`semantic search: ${error.message}`);
  if (!Array.isArray(data)) return [];
  return (data as MasterRow[]).map(masterRowToFact);
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
    // Auto-match (the recipe nutrition panel) wants clean generic foods
    // only; the manual override dialog passes include_branded so the
    // user can still pick a specific brand.
    const includeBranded = body.include_branded === true;
    if (!q) return json({ hits: [] });

    const facts: CachedFact[] = [];
    try {
      const hits = await masterSearch(q, limit, !includeBranded);
      console.log(`master search "${q}" (generic_only=${!includeBranded}) → ${hits.length} hits`);
      facts.push(...hits);
    } catch (e) {
      console.error('master search failed', e);
      Sentry.captureException(e, { tags: { stage: 'master_search' }, extra: { q } });
    }
    // Lexical came up empty or weak (didn't cover the head food noun) —
    // try semantic match over the generic foods before falling back to
    // Open Food Facts. Only for the auto-match path; the override dialog
    // is a direct user query where lexical + branded is what they want.
    if (!includeBranded && lexicalIsWeak(q, facts)) {
      try {
        const sem = await semanticSearch(q, limit);
        if (sem.length > 0) {
          console.log(`semantic search "${q}" → ${sem.length} hits`);
          // Prepend so the semantic best-guess becomes the auto-match,
          // but keep any lexical hits behind it as alternatives.
          facts.unshift(...sem);
        }
      } catch (e) {
        console.error('semantic search failed', e);
        Sentry.captureException(e, { tags: { stage: 'semantic_search' }, extra: { q } });
      }
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
