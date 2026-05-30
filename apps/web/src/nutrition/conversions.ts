import { supabase } from '../supabase.js';

/**
 * Minimal read of the user's HOUSE conversion rules + the platform's
 * GLOBAL defaults, in the shape the nutrition math expects. The full
 * conversion infrastructure (ConversionRegistry / packages/domain)
 * has priority semantics we don't need here — for nutrition we just
 * want every available ingredient × unit → grams rule.
 */
export interface NutritionDensityRule {
  fromUnit: string;
  factor: number;
  ingredientName: string | null;
}

export async function listConversionRulesForOwner(
  ownerId: string,
): Promise<NutritionDensityRule[]> {
  const [house, global] = await Promise.all([
    supabase
      .from('conversion_rules')
      .select('from_unit, factor, ingredient_name, to_unit')
      .eq('owner_id', ownerId)
      .eq('priority', 'HOUSE'),
    supabase
      .from('global_conversions')
      .select('from_unit, to_unit, factor, ingredient_name'),
  ]);
  const out: NutritionDensityRule[] = [];
  // Only keep rules whose target unit is grams — those convert recipe
  // units → mass directly. Anything else would have to chain through
  // another rule, which we don't model here.
  for (const r of (house.data ?? []) as Array<{
    from_unit: string;
    factor: number;
    ingredient_name: string | null;
    to_unit: string;
  }>) {
    if (r.to_unit.toLowerCase() !== 'gram' && r.to_unit.toLowerCase() !== 'g') continue;
    out.push({
      fromUnit: r.from_unit,
      factor: r.factor,
      ingredientName: r.ingredient_name,
    });
  }
  for (const r of (global.data ?? []) as Array<{
    from_unit: string;
    factor: number;
    ingredient_name: string | null;
    to_unit: string;
  }>) {
    if (r.to_unit.toLowerCase() !== 'gram' && r.to_unit.toLowerCase() !== 'g') continue;
    out.push({
      fromUnit: r.from_unit,
      factor: r.factor,
      ingredientName: r.ingredient_name,
    });
  }
  return out;
}
