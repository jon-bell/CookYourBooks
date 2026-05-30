// Pure nutrition math.
//
// Given (a) a recipe's ingredients with quantities, (b) a per-ingredient
// nutrition row (nutrients-per-100g), and (c) the grams-per-recipe-unit
// for that ingredient, produce: total nutrition for the whole recipe,
// and per-serving nutrition under one of two modes — proportion of
// recipe (recipe yields N, you eat 1/N) or by weight (recipe weighs T,
// you eat W).
//
// Lives in @cookyourbooks/domain so the same logic powers the web UI,
// the future mobile UI, and any background nutrition pre-compute we
// add. No framework deps.

export type NutritionSource = 'USDA_FDC' | 'OPEN_FOOD_FACTS';

export interface NutritionFact {
  source: NutritionSource;
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

// Standard volume unit conversions to mL. Everything else
// (ingredient-specific densities) is handled by callers via the
// global_conversions table or the cache's `portions` array.
const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  tsp: 4.92892,
  teaspoon: 4.92892,
  teaspoons: 4.92892,
  tbsp: 14.7868,
  tablespoon: 14.7868,
  tablespoons: 14.7868,
  cup: 236.588,
  cups: 236.588,
  'fluid ounce': 29.5735,
  'fluid ounces': 29.5735,
  'fl oz': 29.5735,
  pint: 473.176,
  pints: 473.176,
  quart: 946.353,
  quarts: 946.353,
  gallon: 3785.41,
  gallons: 3785.41,
};

// Standard mass conversions to grams.
const MASS_TO_G: Record<string, number> = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  mg: 0.001,
  milligram: 0.001,
  milligrams: 0.001,
  oz: 28.3495,
  ounce: 28.3495,
  ounces: 28.3495,
  lb: 453.592,
  pound: 453.592,
  pounds: 453.592,
};

/** Normalize a unit string for lookup. */
function normUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

export interface ConversionContext {
  /**
   * Density rules from the platform's global_conversions table
   * (g per recipe-unit, scoped to ingredient name when applicable).
   * The frontend passes the subset that matches this ingredient.
   */
  densityRules?: Array<{
    fromUnit: string;
    factor: number;
    ingredientName: string | null;
  }>;
  /**
   * Portion data straight from the nutrition source (USDA's
   * foodPortions / OFF's serving_size). Used when global_conversions
   * doesn't cover the unit.
   */
  portions?: { unit: string; grams: number }[];
  /**
   * Optional per-ingredient override the user set on the mapping
   * row (e.g. "I weighed my flour, 1 cup = 130 g, not USDA's 120").
   * Keyed by normalized unit string.
   */
  override?: Record<string, number>;
}

/**
 * Best-effort conversion of (amount, unit) for the named ingredient
 * to grams. Returns null when none of the layered sources matched —
 * the caller surfaces this as "couldn't compute nutrition for this
 * row" rather than guessing.
 *
 * Resolution order:
 *   1. user-supplied override (mapping row's custom_grams_per_unit)
 *   2. global_conversions row matching this ingredient + unit
 *   3. nutrition-source portion data
 *   4. pure mass (g / oz / lb / kg) — independent of ingredient
 *   5. pure volume × generic density 1 g/mL (water-equivalent)
 *      — last-resort approximation, flagged via `approximate: true`
 */
export interface ConversionResult {
  grams: number;
  approximate: boolean;
  source: 'override' | 'density' | 'portion' | 'mass' | 'water-equiv';
}

export function quantityToGrams(
  amount: number,
  unit: string,
  ingredientName: string,
  ctx: ConversionContext,
): ConversionResult | null {
  const u = normUnit(unit);
  const name = ingredientName.trim().toLowerCase();

  // 1. Explicit per-ingredient override.
  if (ctx.override && ctx.override[u] != null) {
    return { grams: amount * ctx.override[u]!, approximate: false, source: 'override' };
  }

  // 2. Match a density rule whose ingredient_name matches OR is null
  //    (null == applies to any ingredient at this unit). Prefer the
  //    ingredient-specific row.
  if (ctx.densityRules && ctx.densityRules.length > 0) {
    const match =
      ctx.densityRules.find(
        (r) => normUnit(r.fromUnit) === u && r.ingredientName?.toLowerCase() === name,
      ) ??
      ctx.densityRules.find(
        (r) => normUnit(r.fromUnit) === u && r.ingredientName == null,
      );
    if (match) {
      return { grams: amount * match.factor, approximate: false, source: 'density' };
    }
  }

  // 3. Nutrition-source portion data.
  if (ctx.portions) {
    const p = ctx.portions.find((x) => normUnit(x.unit) === u);
    if (p) return { grams: amount * p.grams, approximate: false, source: 'portion' };
  }

  // 4. Pure mass.
  if (MASS_TO_G[u] != null) {
    return { grams: amount * MASS_TO_G[u]!, approximate: false, source: 'mass' };
  }

  // 5. Pure volume with water-equivalent density. Marked approximate
  //    so the UI can disclaim.
  if (VOLUME_TO_ML[u] != null) {
    return {
      grams: amount * VOLUME_TO_ML[u]!,
      approximate: true,
      source: 'water-equiv',
    };
  }

  return null;
}

// ---------- Aggregation ----------

export interface IngredientNutritionRow {
  /** Stable id for keying React lists / mapping back to recipe rows. */
  ingredientId: string;
  ingredientName: string;
  /** null when we couldn't convert the recipe quantity to grams. */
  grams: number | null;
  /** null when no nutrition fact resolved for this ingredient. */
  fact: NutritionFact | null;
  /** Grams source was a water-equivalent fallback — display a caveat. */
  approximate: boolean;
}

export interface NutritionTotals {
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  saturated_fat_g: number;
  carbs_g: number;
  sugar_g: number;
  fiber_g: number;
  sodium_mg: number;
  /**
   * Sum of grams for rows that successfully resolved. Used as the
   * default "recipe weight" in the by-weight serving mode.
   */
  total_grams: number;
  /**
   * Count of ingredients that contributed (resolved + had nutrition).
   * Lets the UI say "based on 8 of 10 ingredients".
   */
  resolved_count: number;
  unresolved_count: number;
  approximate_count: number;
}

/**
 * Multiply each row's per-100g facts by its gram weight (over 100)
 * and sum. NULL nutrients contribute 0 to that nutrient's total but
 * don't disqualify the whole row.
 */
export function totalNutrition(rows: readonly IngredientNutritionRow[]): NutritionTotals {
  const out: NutritionTotals = {
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    saturated_fat_g: 0,
    carbs_g: 0,
    sugar_g: 0,
    fiber_g: 0,
    sodium_mg: 0,
    total_grams: 0,
    resolved_count: 0,
    unresolved_count: 0,
    approximate_count: 0,
  };
  for (const r of rows) {
    if (r.grams == null || r.fact == null) {
      out.unresolved_count += 1;
      continue;
    }
    out.resolved_count += 1;
    if (r.approximate) out.approximate_count += 1;
    out.total_grams += r.grams;
    const scale = r.grams / 100;
    out.calories_kcal += (r.fact.calories_kcal ?? 0) * scale;
    out.protein_g += (r.fact.protein_g ?? 0) * scale;
    out.fat_g += (r.fact.fat_g ?? 0) * scale;
    out.saturated_fat_g += (r.fact.saturated_fat_g ?? 0) * scale;
    out.carbs_g += (r.fact.carbs_g ?? 0) * scale;
    out.sugar_g += (r.fact.sugar_g ?? 0) * scale;
    out.fiber_g += (r.fact.fiber_g ?? 0) * scale;
    out.sodium_mg += (r.fact.sodium_mg ?? 0) * scale;
  }
  return out;
}

// ---------- Per-serving ----------

export type ServingMode =
  | { kind: 'proportion'; servings: number }
  | { kind: 'weight'; totalRecipeGrams: number; servingGrams: number };

/**
 * Scale the totals to one serving under the chosen mode. The two
 * modes match the user's stated needs: dividing the recipe by yield
 * ("serves 4, I ate 1/4"), or by weight ("recipe came out to 1200 g,
 * my plate is 250 g").
 *
 * Both modes degrade to "no scaling" when the chosen denominator is
 * non-positive — the UI can detect that and warn rather than dividing
 * by zero.
 */
export function scaleToServing(
  totals: NutritionTotals,
  mode: ServingMode,
): NutritionTotals & { ratio: number } {
  let ratio: number;
  switch (mode.kind) {
    case 'proportion':
      ratio = mode.servings > 0 ? 1 / mode.servings : 1;
      break;
    case 'weight':
      ratio =
        mode.totalRecipeGrams > 0 && mode.servingGrams > 0
          ? mode.servingGrams / mode.totalRecipeGrams
          : 1;
      break;
  }
  return {
    calories_kcal: totals.calories_kcal * ratio,
    protein_g: totals.protein_g * ratio,
    fat_g: totals.fat_g * ratio,
    saturated_fat_g: totals.saturated_fat_g * ratio,
    carbs_g: totals.carbs_g * ratio,
    sugar_g: totals.sugar_g * ratio,
    fiber_g: totals.fiber_g * ratio,
    sodium_mg: totals.sodium_mg * ratio,
    total_grams: totals.total_grams * ratio,
    resolved_count: totals.resolved_count,
    unresolved_count: totals.unresolved_count,
    approximate_count: totals.approximate_count,
    ratio,
  };
}

/** Pretty-print a nutrient. Returns '—' for zero values to keep the
 *  panel quiet when an ingredient has no data on a row. */
export function fmtGrams(g: number, digits = 1): string {
  if (!Number.isFinite(g) || g === 0) return '—';
  return `${g.toFixed(digits)} g`;
}

export function fmtKcal(k: number): string {
  if (!Number.isFinite(k) || k === 0) return '—';
  return `${Math.round(k)} kcal`;
}

export function fmtMg(m: number): string {
  if (!Number.isFinite(m) || m === 0) return '—';
  return `${Math.round(m)} mg`;
}

/** Normalized ingredient lookup key. Lowercase, trimmed, single-spaced. */
export function ingredientLookupKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
