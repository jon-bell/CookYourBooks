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
}): Recipe {
  return {
    id: params.id ?? newRecipeId(),
    title: params.title,
    servings: params.servings,
    ingredients: [...(params.ingredients ?? [])],
    instructions: [...(params.instructions ?? [])],
  };
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
