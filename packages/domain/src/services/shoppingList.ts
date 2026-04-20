import type { Ingredient } from '../model/ingredient.js';
import { isMeasured } from '../model/ingredient.js';
import { quantityToNumber, exact } from '../model/quantity.js';
import type { Recipe } from '../model/recipe.js';

export interface ShoppingItem {
  readonly name: string;
  readonly aggregated: boolean; // true if combined from multiple recipes
  readonly quantityText: string; // formatted
  readonly sourceRecipeIds: readonly string[];
}

export interface ShoppingList {
  readonly measured: readonly ShoppingItem[];
  readonly uncountable: readonly ShoppingItem[];
}

type Accum = {
  name: string;
  unit: string;
  amount: number;
  recipeIds: Set<string>;
  count: number;
};

export function buildShoppingList(recipes: readonly Recipe[]): ShoppingList {
  const measuredByKey = new Map<string, Accum>();
  const vagueByKey = new Map<string, { name: string; recipeIds: Set<string>; count: number }>();

  for (const recipe of recipes) {
    for (const ing of recipe.ingredients) {
      addIngredient(ing, recipe.id, measuredByKey, vagueByKey);
    }
  }

  const measured: ShoppingItem[] = [...measuredByKey.values()].map((a) => ({
    name: a.name,
    aggregated: a.count > 1,
    quantityText: formatAmount(a.amount, a.unit),
    sourceRecipeIds: [...a.recipeIds],
  }));

  const uncountable: ShoppingItem[] = [...vagueByKey.values()].map((a) => ({
    name: a.name,
    aggregated: a.count > 1,
    quantityText: 'as needed',
    sourceRecipeIds: [...a.recipeIds],
  }));

  measured.sort((a, b) => a.name.localeCompare(b.name));
  uncountable.sort((a, b) => a.name.localeCompare(b.name));

  return { measured, uncountable };
}

function addIngredient(
  ing: Ingredient,
  recipeId: string,
  measuredByKey: Map<string, Accum>,
  vagueByKey: Map<string, { name: string; recipeIds: Set<string>; count: number }>,
) {
  if (isMeasured(ing)) {
    const unit = ing.quantity.unit;
    const key = `${ing.name.toLowerCase()}|${unit}`;
    const existing = measuredByKey.get(key);
    const amount = quantityToNumber(ing.quantity);
    if (existing) {
      existing.amount += amount;
      existing.recipeIds.add(recipeId);
      existing.count += 1;
    } else {
      measuredByKey.set(key, {
        name: ing.name,
        unit,
        amount,
        recipeIds: new Set([recipeId]),
        count: 1,
      });
    }
  } else {
    const key = ing.name.toLowerCase();
    const existing = vagueByKey.get(key);
    if (existing) {
      existing.recipeIds.add(recipeId);
      existing.count += 1;
    } else {
      vagueByKey.set(key, { name: ing.name, recipeIds: new Set([recipeId]), count: 1 });
    }
  }
}

function formatAmount(amount: number, unit: string): string {
  const rounded = Math.round(amount * 100) / 100;
  const str = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
  return unit ? `${str} ${unit}` : str;
}

// Exposed for consumers that want to reconstruct an exact quantity.
export { exact };
