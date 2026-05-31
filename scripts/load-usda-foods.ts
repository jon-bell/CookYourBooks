// deno run --allow-env --allow-read --allow-net --allow-sys scripts/load-usda-foods.ts \
//   --dataset foundation --file /path/to/FoodData_Central_foundation_food_json_2025-04-01.json
//
// Bulk-loads a USDA FoodData Central JSON dump into the
// `nutrition_foods_master` table. Streams the JSON so it works on the
// ~400 MB Branded file without exploding memory.
//
// Download dumps from https://fdc.nal.usda.gov/download-datasets.html
// (Foundation Foods JSON, SR Legacy JSON, Survey (FNDDS) JSON,
// Branded Foods JSON). Unzip first.
//
// Reads SUPABASE_URL + SERVICE_ROLE_KEY from `apps/web/.env.local.prod`
// (or `.env.local` / `supabase/.env.prod`) — same pattern as the
// other diagnostic scripts.
//
// Idempotent. Re-run to refresh against a newer USDA dataset; each
// food upserts on (source, source_id). Branded ids that disappear
// upstream are NOT pruned automatically — that's a separate cleanup.
//
// Usage:
//   deno run --allow-env --allow-read --allow-net --allow-sys \
//     scripts/load-usda-foods.ts \
//     --dataset foundation \
//     --file ./FoodData_Central_foundation_food_json_2025-04-01.json
//
//   --dataset    foundation | sr_legacy | survey | branded   (required)
//   --file       path to the unzipped USDA JSON file          (required)
//   --batch      rows per upsert request (default 500)
//   --limit      stop after N foods (debug; default unlimited)
//   --env-file   override credentials file path
//
// Approximate timings against hosted Supabase (one HTTP RTT per
// batch): foundation ~5 s, sr_legacy ~30 s, survey ~30 s, branded
// ~20 min. Run branded last and overnight if you're impatient.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
// stream-json handles giant USDA arrays without loading the whole
// file. Top-level + sub-modules all export lowercase factory functions
// (parser, pick, streamArray, chain) rather than classes.
// Run with `deno run --node-modules-dir=auto` so Deno installs these
// npm packages on demand.
// Deno's npm interop sometimes doesn't surface CJS named exports
// (depends on whether the package decorates module.exports). Use
// default imports and dereference at runtime — works for both shapes.
import streamJson from 'npm:stream-json@1.8.0';
import pickMod from 'npm:stream-json@1.8.0/filters/Pick.js';
import streamArrayMod from 'npm:stream-json@1.8.0/streamers/StreamArray.js';
import streamChain from 'npm:stream-chain@2.2.5';
import { createReadStream } from 'node:fs';

// deno-lint-ignore no-explicit-any
const parser = (streamJson as any).parser ?? streamJson;
// deno-lint-ignore no-explicit-any
const pick = (pickMod as any).pick ?? pickMod;
// deno-lint-ignore no-explicit-any
const streamArray = (streamArrayMod as any).streamArray ?? streamArrayMod;
// stream-chain's default export IS the factory.
// deno-lint-ignore no-explicit-any
const chain = (streamChain as any).chain ?? streamChain;

type DatasetKey = 'foundation' | 'sr_legacy' | 'survey' | 'branded';

interface DatasetSpec {
  envelopeKey: string;   // top-level key in the USDA JSON object
  dataType: string;       // canonical data_type written to Postgres
}

const DATASETS: Record<DatasetKey, DatasetSpec> = {
  foundation: { envelopeKey: 'FoundationFoods', dataType: 'Foundation' },
  sr_legacy:  { envelopeKey: 'SRLegacyFoods',   dataType: 'SR Legacy' },
  survey:     { envelopeKey: 'SurveyFoods',     dataType: 'Survey (FNDDS)' },
  branded:    { envelopeKey: 'BrandedFoods',    dataType: 'Branded' },
};

// USDA nutrient ids that we extract. Same set as the edge function.
const NID = {
  CALORIES: 1008,
  PROTEIN: 1003,
  FAT: 1004,
  SAT_FAT: 1258,
  CARBS: 1005,
  SUGAR: 2000,
  FIBER: 1079,
  SODIUM: 1093, // mg
} as const;

interface FoodNutrient {
  // Modern bulk format: nutrient is nested.
  nutrient?: { id?: number; unitName?: string };
  // Older / search-API format: ids are flat.
  nutrientId?: number;
  amount?: number;
  value?: number;
}

interface FoodPortion {
  modifier?: string;
  measureUnit?: { name?: string };
  portionDescription?: string;
  gramWeight?: number;
  // SR Legacy stores "1 cup = 125g" as { value:1, modifier:"cup", gramWeight:125 }
  // or "2 tbsp = 18g" as { value:2, modifier:"tbsp", gramWeight:18 } —
  // need to divide gramWeight by amount/value to get per-unit grams.
  amount?: number;
  value?: number;
}

interface UsdaFood {
  fdcId: number;
  description: string;
  brandName?: string;
  brandOwner?: string;
  foodNutrients?: FoodNutrient[];
  foodPortions?: FoodPortion[];
  servingSize?: number;
  servingSizeUnit?: string;
  // Branded-only. The nutrition label's serving-size text, free-form
  // ("1 cup", "1/4 cup", "2 tbsp", "1 cookie", "8 fl oz", "30 g").
  householdServingFullText?: string;
}

interface Row {
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

function nutrientValue(food: UsdaFood, id: number): number | null {
  const n = food.foodNutrients?.find(
    (x) => (x.nutrient?.id ?? x.nutrientId) === id,
  );
  if (!n) return null;
  const v = n.amount ?? n.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Foundation / SR Legacy / Survey report per-100g. Branded reports
// per servingSize, so we rescale when servingSize is in grams.
function nutrientsPer100g(food: UsdaFood) {
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
    calories_kcal: s(nutrientValue(food, NID.CALORIES)),
    protein_g: s(nutrientValue(food, NID.PROTEIN)),
    fat_g: s(nutrientValue(food, NID.FAT)),
    saturated_fat_g: s(nutrientValue(food, NID.SAT_FAT)),
    carbs_g: s(nutrientValue(food, NID.CARBS)),
    sugar_g: s(nutrientValue(food, NID.SUGAR)),
    fiber_g: s(nutrientValue(food, NID.FIBER)),
    sodium_mg: s(nutrientValue(food, NID.SODIUM)),
  };
}

// Recognized cooking units we care about extracting from free-form
// household-serving text. Anything else ("1 cookie", "1 piece", "1 bar")
// gets skipped — those aren't useful for unit conversion.
const COOKING_UNIT_ALIASES: Record<string, string> = {
  cup: 'cup', cups: 'cup',
  tbsp: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  'fl oz': 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  pint: 'pint', pints: 'pint', quart: 'quart', quarts: 'quart',
};

/**
 * Parse Branded's free-form "household serving" text into
 * { amount, unit }. Returns null when the text isn't a cooking unit
 * we want to surface (e.g. "1 piece", "30 g"). Handles fractions
 * ("1/4 cup"), mixed numbers ("1 1/2 cup"), and multi-word units
 * ("8 fl oz").
 */
function parseHouseholdServing(text: string): { amount: number; unit: string } | null {
  const trimmed = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  // Match: optional whole + optional "/" fraction, then unit. Examples:
  //   "1 cup" → 1 / "cup"
  //   "1/4 cup" → 0.25 / "cup"
  //   "1 1/2 cup" → 1.5 / "cup"
  //   "8 fl oz" → 8 / "fl oz"
  const m = trimmed.match(/^(\d+(?:\s+\d+\/\d+)?|\d+\/\d+|\d+(?:\.\d+)?)\s+(.+)$/);
  if (!m) return null;
  const numStr = m[1]!;
  let amount = 0;
  if (numStr.includes('/')) {
    const parts = numStr.split(/\s+/);
    for (const part of parts) {
      if (part.includes('/')) {
        const [n, d] = part.split('/').map(Number);
        if (n && d) amount += n / d;
      } else {
        amount += Number(part);
      }
    }
  } else {
    amount = Number(numStr);
  }
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // Unit may have a trailing prep note (", drained") — strip after comma.
  let unitRaw = m[2]!.split(',')[0]!.trim();
  // Drop parentheticals ("1 cup (240mL)" → "cup").
  unitRaw = unitRaw.replace(/\s*\([^)]*\)\s*/g, '').trim();
  const unit = COOKING_UNIT_ALIASES[unitRaw];
  if (!unit) return null;
  return { amount, unit };
}

function portionsFromUsda(food: UsdaFood): { unit: string; grams: number }[] {
  const out: { unit: string; grams: number }[] = [];
  for (const p of food.foodPortions ?? []) {
    // SR Legacy's measureUnit.name is almost always "undetermined" —
    // the actual unit lives in `modifier` ("cup", "tbsp", "1 piece").
    // Branded uses measureUnit.name. Foundation uses portionDescription.
    // Pick the most specific available, skip ambiguous.
    let unit =
      (p.modifier && p.modifier.toLowerCase().trim()) ||
      (p.measureUnit?.name &&
        p.measureUnit.name.toLowerCase() !== 'undetermined' &&
        p.measureUnit.name.toLowerCase()) ||
      (p.portionDescription && p.portionDescription.toLowerCase().trim()) ||
      '';
    if (!unit || unit === 'undetermined' || !p.gramWeight) continue;
    // Strip a leading "1 " ("1 cup" → "cup") since `amount` already
    // captures multiplicity. Don't touch "1/4 cup" style fractions —
    // those identify a distinct portion in some entries.
    unit = unit.replace(/^1\s+/, '');
    // Normalize to grams-per-one-unit so the consumer doesn't have to
    // know whether USDA reported "1 cup = 125g" or "2 cups = 250g".
    const denom = p.amount ?? p.value ?? 1;
    if (!Number.isFinite(denom) || denom <= 0) continue;
    out.push({ unit, grams: p.gramWeight / denom });
  }
  // Branded entries don't populate `foodPortions` — the serving info
  // lives in `householdServingFullText` ("1 cup") + `servingSize` (g).
  // Extract only when servingSize is in grams and the text names a
  // cooking unit; "1 cookie" / "30 g" / "1 bar" get skipped.
  if (
    food.householdServingFullText &&
    typeof food.servingSize === 'number' &&
    food.servingSize > 0 &&
    food.servingSizeUnit?.toLowerCase() === 'g'
  ) {
    const parsed = parseHouseholdServing(food.householdServingFullText);
    if (parsed) {
      out.push({ unit: parsed.unit, grams: food.servingSize / parsed.amount });
    }
  }
  return out;
}

function foodToRow(food: UsdaFood | null | undefined, dataType: string): Row | null {
  if (!food || typeof food.fdcId !== 'number' || !food.description) return null;
  return {
    source: 'USDA_FDC',
    source_id: String(food.fdcId),
    data_type: dataType,
    description: food.description.trim().replace(/\s+/g, ' '),
    brand: food.brandName?.trim() || null,
    brand_owner: food.brandOwner?.trim() || null,
    ...nutrientsPer100g(food),
    portions: portionsFromUsda(food),
  };
}

// ---------- env / args ----------

async function loadEnv(envFileOverride?: string): Promise<Record<string, string>> {
  const candidates = envFileOverride
    ? [new URL('file://' + envFileOverride)]
    : [
        // Same precedence as the other diagnostic scripts. We
        // deliberately do NOT fall back to apps/web/.env.local —
        // that file holds only the publishable anon key and would
        // shadow the gitignored .env.prod that actually carries the
        // service-role key.
        new URL('../apps/web/.env.local.prod', import.meta.url),
        new URL('../supabase/.env.prod', import.meta.url),
      ];
  let text: string | undefined;
  let found: URL | undefined;
  for (const p of candidates) {
    try {
      text = await Deno.readTextFile(p);
      found = p;
      break;
    } catch { /* try next */ }
  }
  if (!text || !found) {
    throw new Error(
      `No env file found. Tried: ${candidates.map((c) => c.pathname).join(', ')}`,
    );
  }
  console.error(`(env from ${found.pathname})`);
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function parseArgs(): {
  dataset: DatasetKey;
  file: string;
  batch: number;
  limit: number | undefined;
  envFile: string | undefined;
} {
  const args = Deno.args;
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const datasetRaw = get('dataset');
  const file = get('file');
  const batch = Number(get('batch') ?? '500');
  const limitRaw = get('limit');
  const envFile = get('env-file');
  if (!datasetRaw || !file) {
    throw new Error('Required: --dataset <foundation|sr_legacy|survey|branded> --file <path>');
  }
  if (!(datasetRaw in DATASETS)) {
    throw new Error(`Unknown dataset "${datasetRaw}". Pick one of: ${Object.keys(DATASETS).join(', ')}`);
  }
  return {
    dataset: datasetRaw as DatasetKey,
    file,
    batch,
    limit: limitRaw ? Number(limitRaw) : undefined,
    envFile,
  };
}

async function upsertBatch(sb: SupabaseClient, rows: Row[]): Promise<void> {
  const { error } = await sb
    .from('nutrition_foods_master')
    .upsert(rows, { onConflict: 'source,source_id' });
  if (error) throw new Error(`upsert ${rows.length} rows: ${error.message}`);
}

async function main() {
  const { dataset, file, batch, limit, envFile } = parseArgs();
  const spec = DATASETS[dataset];
  const env = await loadEnv(envFile);
  const SUPABASE_URL = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  // Accepts the legacy JWT service role or the new sb_secret_ format.
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
  console.error(
    `→ ${dataset} → ${SUPABASE_URL} (envelope: ${spec.envelopeKey}, batch: ${batch}${limit ? `, limit: ${limit}` : ''})`,
  );

  let pending: Row[] = [];
  let total = 0;
  let skipped = 0;
  const t0 = performance.now();
  let lastLog = t0;

  const stream = chain([
    createReadStream(file),
    parser(),
    pick({ filter: spec.envelopeKey }),
    streamArray(),
  ]);

  for await (const { value } of stream as AsyncIterable<{ value: UsdaFood }>) {
    if (limit !== undefined && total >= limit) break;
    const row = foodToRow(value, spec.dataType);
    if (!row) { skipped++; continue; }
    pending.push(row);
    total++;
    if (pending.length >= batch) {
      await upsertBatch(sb, pending);
      pending = [];
      const now = performance.now();
      if (now - lastLog > 2000) {
        const rate = Math.round((total / (now - t0)) * 1000);
        console.error(`  loaded ${total.toLocaleString()} (~${rate}/s)`);
        lastLog = now;
      }
    }
  }
  if (pending.length > 0) {
    await upsertBatch(sb, pending);
  }
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.error(
    `✓ ${total.toLocaleString()} rows in ${elapsed}s (${skipped} skipped — missing fdcId/description)`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error('✗', (e as Error).message);
    Deno.exit(1);
  }
}
