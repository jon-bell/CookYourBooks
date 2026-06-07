import { useQuery } from '@tanstack/react-query';
import {
  ingredientLookupKey,
  quantityToGrams,
  tokenizeIngredient,
  totalNutrition,
  type ConversionContext,
  type IngredientNutritionRow,
  type NutritionFact,
  type NutritionTotals,
} from '@cookyourbooks/domain';
import type { Recipe, Quantity } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useLocalQueryEnabled } from '../local/SyncProvider.js';
import {
  readCachedFact,
  resolveMapping,
  searchNutrition,
} from './api.js';
import { searchLocalEssentials } from './localCache.js';
import { listConversionRulesForOwner } from './conversions.js';

/**
 * Resolve nutrition for every measured ingredient on a recipe and
 * compute the recipe-level total. Vague ingredients ("salt to taste")
 * appear in the row list but contribute nothing.
 *
 * Resolution per ingredient:
 *   1. Look up the persisted mapping (`resolve_nutrition_mapping`).
 *      User-scope wins over platform-default.
 *   2. If mapping exists → read cached fact for (source, source_id).
 *   3. If no mapping → live-search USDA / OFF through the edge
 *      function. The edge function caches each hit; we pick the top
 *      result as the auto-match. The user can override later.
 *
 * Grams computation leans on the existing `global_conversions` table
 * (ingredient-specific densities), then the cache's `portions` array,
 * then pure mass / water-equivalent fallback (last marked approximate).
 */

export interface ResolvedRecipeNutrition {
  rows: IngredientNutritionRow[];
  totals: NutritionTotals;
  /** Whether any ingredient row still has a non-final auto-match — UX
   *  can show a "review matches" CTA. */
  needsReview: boolean;
}

export function useRecipeNutrition(recipe: Recipe | undefined) {
  const { user } = useAuth();
  const localReady = useLocalQueryEnabled();

  return useQuery<ResolvedRecipeNutrition>({
    queryKey: [
      'recipe-nutrition',
      recipe?.id,
      // Re-resolve when the ingredient list materially changes. Keep
      // the key small — comma-joined name|unit|amount tuples.
      recipe?.ingredients
        .map((i) =>
          i.type === 'MEASURED'
            ? `${i.name}|${i.quantity.unit}|${quantityKey(i.quantity)}`
            : `${i.name}|vague`,
        )
        .join(';'),
    ],
    enabled: !!recipe && !!user && localReady,
    queryFn: async (): Promise<ResolvedRecipeNutrition> => {
      if (!recipe) {
        return { rows: [], totals: emptyTotals(), needsReview: false };
      }
      // One conversion-rules fetch per recipe load — cheap, used by
      // every measured-ingredient row.
      const densityRules = user ? await listConversionRulesForOwner(user.id) : [];

      const rows: IngredientNutritionRow[] = [];
      let needsReview = false;

      for (const ing of recipe.ingredients) {
        if (ing.type !== 'MEASURED') {
          rows.push({
            ingredientId: ing.id,
            ingredientName: ing.name,
            grams: null,
            fact: null,
            approximate: false,
          });
          continue;
        }
        const key = ingredientLookupKey(ing.name);
        const mapping = await resolveMapping(key);
        let fact: NutritionFact | null = null;
        if (mapping) {
          fact = await readCachedFact(mapping.source, mapping.source_id);
        }
        if (!fact) {
          // No mapping yet OR cache miss. Try the local Foundation/SR
          // Legacy mirror first — sub-millisecond, no network. Almost
          // every generic cooking ingredient resolves here. Only fall
          // through to the edge function for cases the local snapshot
          // doesn't cover (Branded, or items added to USDA after our
          // last bulk-import refresh). Auto-match is provisional; the
          // user confirms via the override UI, so we don't persist a
          // mapping at this point.
          try {
            const localHits = await searchLocalEssentials(ing.name, 5);
            if (localHits.length > 0) {
              fact = localHits[0]!;
              needsReview = true;
            } else {
              const hits = await searchNutrition(ing.name, 5);
              fact = hits[0] ?? null;
              if (hits.length > 0) needsReview = true;
            }
          } catch (e) {
            console.warn('nutrition search failed', e);
          }
        }

        // Pre-narrow: pass null-named generics through plus any rule
        // whose name shares at least one token with the ingredient.
        // The math layer (`quantityToGrams`) does the real subset-
        // matching + most-specific selection; this filter just keeps
        // its inner loop short.
        const recipeTokens = new Set(tokenizeIngredient(ing.name));
        const ctx: ConversionContext = {
          densityRules: densityRules
            .filter((r) => {
              if (r.ingredientName == null) return true;
              const ruleTokens = tokenizeIngredient(r.ingredientName);
              return ruleTokens.some((t) => recipeTokens.has(t));
            })
            .map((r) => ({
              fromUnit: r.fromUnit,
              factor: r.factor,
              ingredientName: r.ingredientName,
            })),
          portions: fact?.portions ?? [],
          override: mapping?.custom_grams_per_unit as Record<string, number> | undefined,
        };
        const quantityAmount = quantityAmountToNumber(ing.quantity);
        const conv =
          quantityAmount == null
            ? null
            : quantityToGrams(quantityAmount, ing.quantity.unit, ing.name, ctx);

        rows.push({
          ingredientId: ing.id,
          ingredientName: ing.name,
          grams: conv?.grams ?? null,
          fact,
          approximate: conv?.approximate ?? false,
        });
      }
      const totals = totalNutrition(rows);
      return { rows, totals, needsReview };
    },
  });
}

function emptyTotals(): NutritionTotals {
  return {
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
}

// Domain Quantity is a discriminated union. Reduce to a single number
// for the gram calculation; ranges collapse to their midpoint.
function quantityAmountToNumber(q: Quantity): number | null {
  switch (q.type) {
    case 'EXACT':
      return q.amount;
    case 'FRACTIONAL':
      return (q.whole ?? 0) + (q.numerator ?? 0) / (q.denominator || 1);
    case 'RANGE':
      return (q.min + q.max) / 2;
  }
}

function quantityKey(q: Quantity): string {
  const n = quantityAmountToNumber(q);
  return n == null ? '?' : n.toFixed(3);
}
