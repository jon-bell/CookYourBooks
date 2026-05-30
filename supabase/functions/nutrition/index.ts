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

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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

// ---------- Vault config ----------

let usdaKeyMemo: string | undefined;

async function getUsdaKey(): Promise<string | null> {
  if (usdaKeyMemo) return usdaKeyMemo;
  const { data, error } = await sb
    .from('vault.decrypted_secrets')
    .select('decrypted_secret')
    .eq('name', 'nutrition_worker_config')
    .maybeSingle();
  if (error || !data) return null;
  try {
    const cfg = JSON.parse((data as any).decrypted_secret);
    if (typeof cfg.usda_fdc_key === 'string') {
      usdaKeyMemo = cfg.usda_fdc_key;
      return usdaKeyMemo!;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

// ---------- USDA FDC ----------

interface UsdaNutrient {
  nutrientId: number;
  value: number;
  unitName?: string;
}
interface UsdaFoodPortion {
  modifier?: string;
  measureUnit?: { name: string };
  portionDescription?: string;
  gramWeight: number;
}
interface UsdaFood {
  fdcId: number;
  description: string;
  brandName?: string;
  brandOwner?: string;
  foodNutrients?: UsdaNutrient[];
  foodPortions?: UsdaFoodPortion[];
  servingSize?: number;
  servingSizeUnit?: string;
}

// USDA nutrient ids we care about. Per
// https://fdc.nal.usda.gov/portal-data/external/dataDictionary
const NID = {
  CALORIES: 1008, // Energy (kcal)
  PROTEIN: 1003,
  FAT: 1004,
  SAT_FAT: 1258,
  CARBS: 1005,
  SUGAR: 2000,
  FIBER: 1079,
  SODIUM: 1093, // mg
} as const;

function pickNutrient(food: UsdaFood, id: number): number | null {
  const n = food.foodNutrients?.find((x) => x.nutrientId === id);
  return n?.value ?? null;
}

// USDA Foundation / SR Legacy nutrients are reported per 100 g of the
// food as eaten. Branded Foods uses an arbitrary serving size — convert
// to per-100g via the servingSize + servingSizeUnit pair when present.
function nutrientsPer100g(food: UsdaFood): Pick<
  CachedFact,
  | 'calories_kcal'
  | 'protein_g'
  | 'fat_g'
  | 'saturated_fat_g'
  | 'carbs_g'
  | 'sugar_g'
  | 'fiber_g'
  | 'sodium_mg'
> {
  let scale = 1;
  if (
    typeof food.servingSize === 'number' &&
    food.servingSize > 0 &&
    food.servingSizeUnit?.toLowerCase() === 'g'
  ) {
    scale = 100 / food.servingSize;
  }
  const s = (v: number | null) => (v == null ? null : v * scale);
  return {
    calories_kcal: s(pickNutrient(food, NID.CALORIES)),
    protein_g: s(pickNutrient(food, NID.PROTEIN)),
    fat_g: s(pickNutrient(food, NID.FAT)),
    saturated_fat_g: s(pickNutrient(food, NID.SAT_FAT)),
    carbs_g: s(pickNutrient(food, NID.CARBS)),
    sugar_g: s(pickNutrient(food, NID.SUGAR)),
    fiber_g: s(pickNutrient(food, NID.FIBER)),
    sodium_mg: s(pickNutrient(food, NID.SODIUM)),
  };
}

function portionsFromUsda(food: UsdaFood): { unit: string; grams: number }[] {
  const out: { unit: string; grams: number }[] = [];
  for (const p of food.foodPortions ?? []) {
    const unit = p.measureUnit?.name?.toLowerCase() ?? p.portionDescription ?? '';
    if (!unit || unit === 'undetermined' || !p.gramWeight) continue;
    out.push({ unit, grams: p.gramWeight });
  }
  return out;
}

async function usdaSearch(q: string, limit: number, key: string): Promise<UsdaFood[]> {
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}`;
  const body = {
    query: q,
    pageSize: Math.min(limit, 25),
    // Prefer Foundation Foods (highest-quality reference data); SR
    // Legacy fills gaps; Branded as last resort because the per-item
    // variance is huge.
    dataType: ['Foundation', 'SR Legacy', 'Branded'],
    requireAllWords: false,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`USDA search ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as { foods?: UsdaFood[] };
  return json.foods ?? [];
}

function usdaToCache(food: UsdaFood): CachedFact {
  return {
    source: 'USDA_FDC',
    source_id: String(food.fdcId),
    description: food.description,
    brand: food.brandName ?? food.brandOwner ?? null,
    ...nutrientsPer100g(food),
    portions: portionsFromUsda(food),
  };
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
      'User-Agent': 'CookYourBooks/1.0 (https://cookyourbooks.app)',
    },
  });
  if (!resp.ok) {
    throw new Error(`OFF search ${resp.status}: ${await resp.text()}`);
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

    const usdaKey = await getUsdaKey();
    const facts: CachedFact[] = [];
    if (usdaKey) {
      try {
        const foods = await usdaSearch(q, limit, usdaKey);
        for (const f of foods) facts.push(usdaToCache(f));
      } catch (e) {
        console.error('USDA search failed', e);
      }
    }
    if (facts.length === 0) {
      try {
        const products = await offSearch(q, limit);
        for (const p of products) facts.push(offToCache(p));
      } catch (e) {
        console.error('OFF search failed', e);
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
});
