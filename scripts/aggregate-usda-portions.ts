// deno run --allow-env --allow-read --allow-net scripts/aggregate-usda-portions.ts
//
// Mines `nutrition_foods_master.portions` for cup/tbsp/tsp/fl oz →
// gram weights, computes per-ingredient medians, and upserts them
// into `global_conversions` as derived density defaults.
//
// Idempotent: uses ON CONFLICT DO NOTHING so any hand-curated row in
// `global_conversions` (e.g. the King Arthur seed) survives. To
// re-derive, delete the relevant rows first via the admin UI.
//
// Run AFTER `load-usda-foods.ts` has populated the master table —
// otherwise there's nothing to aggregate from. Order:
//   1. supabase db push  (creates master table + KA seed)
//   2. load-usda-foods.ts × {foundation, sr_legacy, survey, branded}
//   3. this script (fills the long tail)
//
// Reads creds from apps/web/.env.local.prod / .env.local — same
// pattern as the other diagnostic scripts.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';

// Common cooking ingredients we want a default density for. Keep this
// list curated rather than mining all keywords — random USDA Branded
// entries ("Cheez-It Crackers") aren't useful as generic defaults.
//
// For each keyword we run an `ILIKE %keyword%` against `description`.
// First match wins for assigning an ingredient_name (we use the bare
// keyword), so order doesn't matter for correctness but does for the
// `ingredient_name` we emit.
const KEYWORDS = [
  // Flours / starches not already in the KA seed
  'spelt flour', 'tapioca starch', 'potato starch', 'arrowroot',
  'oat flour', 'buckwheat flour', 'masa harina',
  // Sugars
  'turbinado sugar', 'demerara sugar', 'muscovado',
  // Liquids
  'apple juice', 'orange juice', 'coconut milk', 'soy sauce', 'tamari',
  'rice vinegar', 'white wine vinegar', 'apple cider vinegar',
  'balsamic vinegar', 'fish sauce', 'mirin', 'sake', 'sherry',
  'beer', 'red wine', 'white wine', 'chicken broth', 'vegetable broth',
  'beef broth',
  // Pastes / spreads
  'tahini', 'miso', 'tomato paste', 'tomato sauce', 'pesto', 'hummus',
  // Cheeses (most are weighed in recipes, but cup measures exist)
  'parmesan', 'cheddar', 'mozzarella', 'feta', 'ricotta', 'cream cheese',
  'cottage cheese',
  // Grains
  'quinoa', 'couscous', 'barley', 'farro', 'bulgur', 'wild rice',
  'pearl barley', 'millet',
  // Dried beans / legumes
  'lentils', 'chickpeas', 'black beans', 'kidney beans', 'white beans',
  'pinto beans', 'navy beans',
  // Nuts and seeds (KA covers pecans/walnuts/almonds, add the rest)
  'cashews', 'pistachios', 'hazelnuts', 'pine nuts', 'sunflower seeds',
  'pumpkin seeds', 'sesame seeds', 'chia seeds', 'flax seeds',
  // Dried fruits
  'dates', 'figs', 'apricots', 'cranberries', 'cherries',
  // Frozen / common produce by volume
  'frozen peas', 'frozen corn', 'frozen spinach',
];

const UNIT_TO_ML: Record<string, number> = {
  cup: 240,
  cups: 240,
  tablespoon: 14.79,
  tbsp: 14.79,
  tbs: 14.79,
  teaspoon: 4.93,
  tsp: 4.93,
  'fl oz': 29.57,
  'fluid ounce': 29.57,
  'fluid ounces': 29.57,
  pint: 473.18,
  quart: 946.35,
};

interface MasterRow {
  description: string;
  portions: { unit: string; grams: number }[] | null;
}

interface Stat {
  keyword: string;
  factors: number[];
  rowCount: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >>> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function loadEnv(): Promise<Record<string, string>> {
  const candidates = [
    // Matches the other diagnostic scripts; we intentionally skip
    // apps/web/.env.local because it only has the publishable key.
    new URL('../apps/web/.env.local.prod', import.meta.url),
    new URL('../supabase/.env.prod', import.meta.url),
  ];
  let text: string | undefined;
  for (const p of candidates) {
    try {
      text = await Deno.readTextFile(p);
      break;
    } catch { /* try next */ }
  }
  if (!text) throw new Error('No env file found (apps/web/.env.local.prod or fallback)');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
  return env;
}

async function aggregateKeyword(
  sb: SupabaseClient,
  keyword: string,
): Promise<Stat> {
  // Cap at 500 matches; for big keyword hits (e.g. "milk") this still
  // gives a very tight median. Branded duplicates would otherwise
  // dominate the histogram.
  const { data, error } = await sb
    .from('nutrition_foods_master')
    .select('description, portions')
    .ilike('description', `%${keyword}%`)
    // Skip the Branded tier — its portion data is hand-typed by
    // brand submitters and noisier. Foundation/SR Legacy/FNDDS have
    // analytical lab measures.
    .neq('data_type', 'Branded')
    .limit(500);
  if (error) throw new Error(`fetch "${keyword}": ${error.message}`);
  const rows = (data ?? []) as MasterRow[];

  const factors: number[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.portions)) continue;
    for (const p of row.portions) {
      const unit = (p.unit ?? '').toLowerCase().trim();
      const ml = UNIT_TO_ML[unit];
      if (!ml || !p.grams || p.grams <= 0) continue;
      const factor = p.grams / ml;
      // Sanity bounds — anything outside this isn't a sensible food
      // density (water is ~1.0; oil ~0.92; honey ~1.4; lightest
      // useful is fluffy puffed rice ~0.05; heaviest is salt ~1.4).
      if (factor < 0.05 || factor > 2.0) continue;
      factors.push(factor);
    }
  }
  return { keyword, factors, rowCount: rows.length };
}

async function upsertDerived(
  sb: SupabaseClient,
  keyword: string,
  factor: number,
  sampleCount: number,
  matchedFoods: number,
): Promise<'inserted' | 'skipped'> {
  const { error } = await sb.from('global_conversions').insert({
    from_unit: 'milliliter',
    to_unit: 'gram',
    factor: Number(factor.toFixed(3)),
    ingredient_name: keyword,
    notes: `derived: median of ${sampleCount} portions across ${matchedFoods} USDA foods (non-Branded)`,
  });
  if (error) {
    // 23505 = unique_violation: row already exists for this
    // (from_unit, to_unit, ingredient_name). Treat as a no-op — the
    // existing row was hand-curated and we don't overwrite.
    if (String(error.code) === '23505') return 'skipped';
    throw new Error(`upsert "${keyword}": ${error.message} (${error.code})`);
  }
  return 'inserted';
}

async function main() {
  const env = await loadEnv();
  const SUPABASE_URL = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const SERVICE_ROLE_KEY =
    env.SUPABASE_SERVICE_ROLE_KEY ??
    env.SERVICE_ROLE_KEY ??
    env.SUPABASE_SECRET_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SERVICE_ROLE_KEY in env file');
  }
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.error(`→ aggregating ${KEYWORDS.length} keywords against ${SUPABASE_URL}`);
  let inserted = 0;
  let skipped = 0;
  let noData = 0;

  for (const keyword of KEYWORDS) {
    const stat = await aggregateKeyword(sb, keyword);
    if (stat.factors.length < 5) {
      console.error(
        `  - ${keyword.padEnd(30)} too few portion samples (${stat.factors.length}); skipped`,
      );
      noData++;
      continue;
    }
    const med = median(stat.factors);
    const result = await upsertDerived(sb, keyword, med, stat.factors.length, stat.rowCount);
    if (result === 'inserted') {
      console.error(
        `  + ${keyword.padEnd(30)} ${med.toFixed(3)} g/mL  ` +
          `(median of ${stat.factors.length} portions, ${stat.rowCount} foods)`,
      );
      inserted++;
    } else {
      console.error(`  = ${keyword.padEnd(30)} already curated; left alone`);
      skipped++;
    }
  }

  console.error(`✓ ${inserted} inserted, ${skipped} skipped (curated), ${noData} no data`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error('✗', (e as Error).message);
    Deno.exit(1);
  }
}
