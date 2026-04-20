import type { Ingredient } from './ingredient.js';
import { isMeasured } from './ingredient.js';
import { measured, vague } from './ingredient.js';
import { scaleQuantity } from './quantity.js';
import type { Instruction } from './instruction.js';
import type { Servings } from './servings.js';

export interface Recipe {
  readonly id: string;
  readonly title: string;
  readonly servings?: Servings;
  readonly ingredients: readonly Ingredient[];
  readonly instructions: readonly Instruction[];
  /** Free-form cook's notes ("halve the salt", "rested 30m not 10m"). */
  readonly notes?: string;
  /** Set when this recipe was derived via `adaptRecipe` from another. */
  readonly parentRecipeId?: string;
}

export function newRecipeId(): string {
  return crypto.randomUUID();
}

export function createRecipe(params: {
  id?: string;
  title: string;
  servings?: Servings;
  ingredients?: readonly Ingredient[];
  instructions?: readonly Instruction[];
  notes?: string;
  parentRecipeId?: string;
}): Recipe {
  return {
    id: params.id ?? newRecipeId(),
    title: params.title,
    servings: params.servings,
    ingredients: [...(params.ingredients ?? [])],
    instructions: [...(params.instructions ?? [])],
    notes: params.notes,
    parentRecipeId: params.parentRecipeId,
  };
}

/**
 * Clone a recipe into a fresh adaptation: new ids for the recipe
 * itself, every ingredient, and every instruction, with
 * step→ingredient refs remapped through the id map. The result's
 * `parentRecipeId` points back at `base.id` so the UI can render
 * lineage.
 *
 * `notes` starts empty — the user's tweaks are what we want them to
 * jot down. `overrides.title` defaults to "<base title> (adaptation)"
 * so the list view disambiguates the two at a glance.
 */
export function adaptRecipe(
  base: Recipe,
  overrides: { title?: string; notes?: string } = {},
): Recipe {
  const ingredientIdMap = new Map<string, string>();
  const ingredients = base.ingredients.map((ing) => {
    const newId = newRecipeId();
    ingredientIdMap.set(ing.id, newId);
    if (isMeasured(ing)) {
      return measured({
        id: newId,
        name: ing.name,
        preparation: ing.preparation,
        notes: ing.notes,
        quantity: ing.quantity,
      });
    }
    return vague({
      id: newId,
      name: ing.name,
      preparation: ing.preparation,
      notes: ing.notes,
    });
  });
  const instructions = base.instructions.map((step) => ({
    ...step,
    id: newRecipeId(),
    ingredientRefs: step.ingredientRefs
      .map((ref) => ingredientIdMap.get(ref.ingredientId))
      .filter((id): id is string => typeof id === 'string')
      .map((ingredientId) => ({ ingredientId })),
  }));
  return createRecipe({
    title: overrides.title ?? `${base.title} (adaptation)`,
    servings: base.servings,
    ingredients,
    instructions,
    notes: overrides.notes,
    parentRecipeId: base.id,
  });
}

export function scaleRecipe(recipe: Recipe, factor: number): Recipe {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`Invalid scale factor: ${factor}`);
  }
  const ingredients = recipe.ingredients.map((ing): Ingredient => {
    if (isMeasured(ing)) {
      return measured({
        id: ing.id,
        name: ing.name,
        quantity: scaleQuantity(ing.quantity, factor),
        preparation: ing.preparation,
        notes: ing.notes,
      });
    }
    return vague({
      id: ing.id,
      name: ing.name,
      preparation: ing.preparation,
      notes: ing.notes,
    });
  });
  const servings = recipe.servings
    ? { amount: recipe.servings.amount * factor, description: recipe.servings.description }
    : undefined;
  return { ...recipe, ingredients, servings };
}
