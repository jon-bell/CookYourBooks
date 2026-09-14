import type { NutritionFact, NutritionSource } from '@cookyourbooks/domain';
import { extractIngredientTerms } from '@cookyourbooks/domain';

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
  const rows = await db.execO<LocalNutritionRow>(
    `select * from nutrition_facts where source = ? and source_id = ?`,
    [source, sourceId],
  );
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

/**
 * Words where the recipe vocabulary and the USDA vocabulary disagree
 * about the same food. USDA writes "raw" where a recipe writes "fresh"
 * — "Ginger root, raw", "Spinach, raw", "Cilantro, raw" — so without
 * this "fresh ginger" lost to "Tea, ginger" and "fresh spinach" to
 * "Spinach, fresh, cooked with oil", which is a different food
 * nutritionally.
 *
 * Deliberately tiny. This is not a thesaurus: every entry widens what
 * counts as a whole-word match, so a loose one would undo the precision
 * the word-boundary matching just bought. Measured over the production
 * corpus this pair changes 72 ingredient names and improves all of them.
 * Broader synonymy belongs in the canonical ingredient layer, where it
 * can be reviewed per ingredient.
 */
const MATCH_SYNONYMS: Record<string, string[]> = {
  fresh: ['raw'],
  raw: ['fresh'],
};

/**
 * Search the locally-mirrored generic USDA subset. Sub-millisecond over
 * the ~13.5k rows we mirror — no network. This is the FIRST try in
 * `useRecipeNutrition`, so in practice it is *the* matcher; the edge
 * function only sees what this returns nothing for.
 *
 * Rewritten 2026-09 after an audit measured it at 18.5% usable against
 * 91.1% for the curated mapping table. Three defects, all fixed here:
 *
 *  1. It matched with `LIKE '%term%'` — infix substring, so "honey" hit
 *     "Melons, honeydew", "pure" hit "Tomato, puree", "bay" hit
 *     "Scallops, bay, Patagonian". Now the mirrored blob is tokenized and
 *     space-padded, so a term can be required to match on word
 *     boundaries. A whole-word hit outranks a prefix hit, which keeps
 *     plurals working ("tomato" still finds "tomatoes") without letting
 *     "pure" claim "puree".
 *  2. `data_type` was the FIRST sort key. Foundation is only 363 rows and
 *     always sorted first, so a Foundation row matching ONE token beat an
 *     SR Legacy row matching all of them — this is why "ground black
 *     pepper" resolved to ground turkey. Coverage now leads and tier is
 *     the last tiebreak, matching the server's deliberate ordering.
 *  3. A null-calorie row could win. 73.8% of Foundation rows have no
 *     calories, and they silently zeroed 12.6% of ingredient occurrences.
 *     That is now a hard filter, not a sort key: we would rather return
 *     nothing and let the caller say "not counted" than return a row that
 *     contributes zero to every nutrient.
 *
 * Term extraction is the shared `extractIngredientTerms`, so a query
 * resolves the same way whether served locally or remotely. For items the
 * snapshot can't answer, the caller falls back to `searchNutrition()`
 * (which adds Branded + the semantic fallback).
 */
export async function searchLocalEssentials(q: string, limit = 10): Promise<NutritionFact[]> {
  const { terms, core } = extractIngredientTerms(q);
  if (terms.length === 0) return [];
  const db = await getLocalDb();

  // `search_blob` is tokenized and space-padded (see buildSearchBlob in
  // local/sync.ts), so ' term ' is a whole-word test and ' term' is a
  // word-initial prefix test.
  //
  // Whole-word matching has to tolerate plurals or it is worse than the
  // substring matching it replaces: a recipe says "yellow onion" and
  // USDA says "Onions, raw", so a strict ' onion ' probe misses the
  // right row and lets "Onion dip, light" win. These few suffixes cover
  // the regular cases; irregulars (leaf/leaves) fall back to the prefix
  // and coverage signals below.
  const variantsOf = (t: string): string[] => {
    const out = new Set([t, `${t}s`, `${t}es`]);
    if (t.endsWith('es') && t.length > 3) out.add(t.slice(0, -2));
    if (t.endsWith('s') && t.length > 2) out.add(t.slice(0, -1));
    for (const syn of MATCH_SYNONYMS[t] ?? []) out.add(syn);
    return [...out];
  };
  // A whole-word probe for one term = OR over its inflections.
  const wordSql: string[] = [];
  const wordParams: string[] = [];
  for (const t of terms) {
    const vs = variantsOf(t);
    wordSql.push(`(${vs.map(() => 'search_blob like ?').join(' or ')})`);
    for (const v of vs) wordParams.push(`% ${v} %`);
  }
  const prefixParams = terms.map((t) => `% ${t}%`);
  const head = core[0] ?? '';
  const headVariants = head ? variantsOf(head) : [];
  const headWordSql = headVariants.length
    ? `(${headVariants.map(() => 'search_blob like ?').join(' or ')})`
    : 'false';
  const headPrefixSql = headVariants.length
    ? `(${headVariants.map(() => 'search_blob like ?').join(' or ')})`
    : 'false';

  // Token count of the blob: it is space-padded and single-spaced, so
  // the number of separators minus one is the number of tokens.
  const BLOB_TOKENS = "(length(search_blob) - length(replace(search_blob, ' ', '')) - 1)";

  // Retrieval stays permissive (prefix, OR) so plurals and inflections
  // still reach us; the ordering below decides what actually wins.
  const orWhere = terms.map(() => 'search_blob like ?').join(' or ');
  const wordCoverage = wordSql.map((w) => `(${w})`).join(' + ');
  const prefixCoverage = terms.map(() => '(search_blob like ?)').join(' + ');

  const rows = await db.execO<EssentialsLocalRow>(
    `select * from nutrition_foods_essentials
       where (${orWhere})
         -- Hard filter, not a sort key: a row with no calories
         -- contributes zero to every nutrient and silently deflates the
         -- whole recipe. Better to return nothing.
         and calories_kcal is not null
       order by
         -- 1. is the head food noun present at all, as a whole word?
         --    This gates everything else: a row that never mentions the
         --    food cannot be the food, however well it scores otherwise.
         --    It is what stops "ground black pepper" reaching ground
         --    turkey and "honey" reaching honeydew.
         (case when ${headWordSql} then 1 else 0 end) desc,
         -- 2. coverage, penalised for every extra token the description
         --    carries. Raw coverage rewards long descriptions that happen
         --    to contain every query word — "Pretzels, soft,
         --    ready-to-eat, unsalted, no butter" covers both terms of
         --    "unsalted butter" while "Butter, NFS" covers one, and
         --    "Sauce, peanut, made from peanut butter, water, soy sauce"
         --    beats "Soy sauce". The penalty is what picks the food over
         --    the dish that mentions it.
         ((${wordCoverage}) - 0.25 * ${BLOB_TOKENS}) desc,
         -- 3. does the description START with the head noun? USDA
         --    generic descriptions are head-first ("Oil, olive", "Salt,
         --    table"), so this is a strong "this row IS the food" signal.
         --    It sits BELOW coverage on purpose: promoting it above sends
         --    "ground black pepper" to "Pepper steak" and "ground
         --    cinnamon" to "Cinnamon buns".
         (case when ${headPrefixSql} then 1 else 0 end) desc,
         -- 4. coverage ratio, as a finer-grained version of 2
         ((${wordCoverage}) * 1.0 / max(${BLOB_TOKENS}, 1)) desc,
         -- 5. looser coverage, so prefix matches still rank
         (${prefixCoverage}) desc,
         -- 6. shorter descriptions are the more generic food
         length(description) asc,
         -- 7. tier LAST — a concise on-topic SR Legacy row should beat a
         --    Foundation row that merely contains a query word
         case data_type
           when 'Foundation' then 0
           when 'SR Legacy' then 1
           when 'Survey (FNDDS)' then 2
           else 9 end asc,
         description asc
       limit ?`,
    [
      ...prefixParams, // where: OR retrieval
      ...headVariants.map((v) => `% ${v} %`), // 1. head present anywhere
      ...wordParams, // 2. penalised coverage
      ...headVariants.map((v) => ` ${v}%`), // 3. description starts with head
      ...wordParams, // 4. ratio numerator
      ...prefixParams, // 5. prefix coverage
      limit,
    ],
  );
  return rows.map(essentialsToFact);
}
