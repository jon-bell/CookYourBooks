import type { NutritionFact, NutritionSource } from '@cookyourbooks/domain';
import { getLocalDb } from '../local/db.js';

// Lazy local mirror of the server's nutrition_facts_cache. Populated
// opportunistically when the nutrition hook resolves a fact via the
// server-side cache read or the edge-function search. Subsequent
// reads short-circuit the network round-trip.
//
// Not CRR — these rows are system-wide reference data; the server
// is the canonical owner. Going stale here is OK; the next view that
// misses the local row falls back to the server (which is itself a
// cache of the underlying USDA / Open Food Facts data).

interface LocalNutritionRow {
  source: string;
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
  portions: string;
}

function rowToFact(r: LocalNutritionRow): NutritionFact {
  let portions: { unit: string; grams: number }[] = [];
  try {
    const parsed: unknown = JSON.parse(r.portions);
    if (Array.isArray(parsed)) portions = parsed as { unit: string; grams: number }[];
  } catch {
    /* fall through to empty */
  }
  return {
    source: r.source as NutritionSource,
    source_id: r.source_id,
    description: r.description,
    brand: r.brand,
    calories_kcal: r.calories_kcal,
    protein_g: r.protein_g,
    fat_g: r.fat_g,
    saturated_fat_g: r.saturated_fat_g,
    carbs_g: r.carbs_g,
    sugar_g: r.sugar_g,
    fiber_g: r.fiber_g,
    sodium_mg: r.sodium_mg,
    portions,
  };
}

/** Read one fact from the local cache. Returns null on miss. */
export async function readLocalFact(
  source: NutritionSource,
  sourceId: string,
): Promise<NutritionFact | null> {
  const db = await getLocalDb();
  const rows = (await db.execO<LocalNutritionRow>(
    `select * from nutrition_facts where source = ? and source_id = ?`,
    [source, sourceId],
  )) as LocalNutritionRow[];
  if (rows.length === 0) return null;
  return rowToFact(rows[0]!);
}

/** Write a fact into the local cache. Idempotent — re-running just
 *  refreshes the row. */
export async function writeLocalFact(fact: NutritionFact): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into nutrition_facts
       (source, source_id, description, brand,
        calories_kcal, protein_g, fat_g, saturated_fat_g,
        carbs_g, sugar_g, fiber_g, sodium_mg,
        portions, fetched_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(source, source_id) do update set
       description = excluded.description,
       brand = excluded.brand,
       calories_kcal = excluded.calories_kcal,
       protein_g = excluded.protein_g,
       fat_g = excluded.fat_g,
       saturated_fat_g = excluded.saturated_fat_g,
       carbs_g = excluded.carbs_g,
       sugar_g = excluded.sugar_g,
       fiber_g = excluded.fiber_g,
       sodium_mg = excluded.sodium_mg,
       portions = excluded.portions,
       fetched_at = excluded.fetched_at`,
    [
      fact.source,
      fact.source_id,
      fact.description,
      fact.brand,
      fact.calories_kcal,
      fact.protein_g,
      fact.fat_g,
      fact.saturated_fat_g,
      fact.carbs_g,
      fact.sugar_g,
      fact.fiber_g,
      fact.sodium_mg,
      JSON.stringify(fact.portions ?? []),
      Date.now(),
    ],
  );
}

/** Bulk write — used when a search returns multiple hits and we want
 *  to cache them all so subsequent overrides land instantly. */
export async function writeLocalFacts(facts: readonly NutritionFact[]): Promise<void> {
  for (const f of facts) await writeLocalFact(f);
}

// ---------- USDA essentials search (Foundation + SR Legacy) ----------

interface EssentialsLocalRow {
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
  portions: string;
}

function essentialsToFact(r: EssentialsLocalRow): NutritionFact {
  let portions: { unit: string; grams: number }[] = [];
  try {
    const parsed: unknown = JSON.parse(r.portions);
    if (Array.isArray(parsed)) portions = parsed as { unit: string; grams: number }[];
  } catch {
    /* fall through */
  }
  return {
    source: r.source as NutritionSource,
    source_id: r.source_id,
    description: r.description,
    brand: r.brand ?? r.brand_owner ?? null,
    calories_kcal: r.calories_kcal,
    protein_g: r.protein_g,
    fat_g: r.fat_g,
    saturated_fat_g: r.saturated_fat_g,
    carbs_g: r.carbs_g,
    sugar_g: r.sugar_g,
    fiber_g: r.fiber_g,
    sodium_mg: r.sodium_mg,
    portions,
  };
}

// Strip recipe-ese before searching: matches the edge function's
// normalizeForSearch so a query like "flour (sifted), measured" lands
// the same row whether served locally or remotely.
function normalize(q: string): string {
  return q
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/,.*$/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.-]+|[\s"'.-]+$/g, '')
    .trim();
}

/**
 * LIKE-based search against the locally-mirrored Foundation + SR Legacy
 * subset. Sub-millisecond for the ~8k rows we mirror — no network. Used
 * as the first-try in `useRecipeNutrition` so the common path never
 * waits on the edge function.
 *
 * For Branded items (or anything not in the snapshot) the caller falls
 * back to the remote `searchNutrition()` path.
 */
export async function searchLocalEssentials(
  q: string,
  limit = 10,
): Promise<NutritionFact[]> {
  const normalized = normalize(q);
  if (!normalized) return [];
  const db = await getLocalDb();
  // Require every word from the query to appear somewhere in the blob.
  // Short and effective for ingredient-style queries ("cottage cheese",
  // "all-purpose flour"). Word order doesn't matter.
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const wheres = words.map(() => 'search_blob like ?').join(' and ');
  const params = words.map((w) => `%${w}%`);
  const rows = (await db.execO<EssentialsLocalRow>(
    // Foundation outranks SR Legacy. Within each tier, prefer entries
    // that actually have calories (USDA stores energy as a separate
    // nutrient and plenty of rows arrive without it — useless for
    // anyone counting calories). Then shorter descriptions (less
    // specific = better generic match) and alphabetical for stability.
    `select * from nutrition_foods_essentials
       where ${wheres}
       order by
         case data_type when 'Foundation' then 0 when 'SR Legacy' then 1 else 9 end asc,
         case when calories_kcal is null then 1 else 0 end asc,
         length(description) asc,
         description asc
       limit ?`,
    [...params, limit],
  )) as EssentialsLocalRow[];
  return rows.map(essentialsToFact);
}
