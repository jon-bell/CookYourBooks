import type { Quantity } from './quantity.js';

/**
 * Provenance of an ingredient's `linkedRecipeId` cross-reference:
 * - `auto`      — created by the same-collection matcher.
 * - `manual`    — the user explicitly linked (may target another book).
 * - `dismissed` — the user unlinked; suppresses auto-linking so a rescan
 *                 won't re-add it (`linkedRecipeId` is cleared).
 */
export type LinkSource = 'auto' | 'manual' | 'dismissed';

export interface MeasuredIngredient {
  readonly type: 'MEASURED';
  readonly id: string;
  readonly name: string;
  readonly quantity: Quantity;
  readonly preparation?: string;
  readonly notes?: string;
  /**
   * When this ingredient is itself a recipe in the library (a component /
   * sub-recipe), the linked recipe's id. See `services/recipeLinks.ts`.
   */
  readonly linkedRecipeId?: string;
  readonly linkSource?: LinkSource;
}

export interface VagueIngredient {
  readonly type: 'VAGUE';
  readonly id: string;
  readonly name: string;
  readonly preparation?: string;
  readonly notes?: string;
  /**
   * Qualifier for the vagueness — "to taste", "as needed", "for
   * greasing the pan". Kept separate from `preparation` (which is a
   * transformation of the ingredient itself — "minced", "at room
   * temperature") and `notes` (free-form extras).
   */
  readonly description?: string;
  /** See {@link MeasuredIngredient.linkedRecipeId}. */
  readonly linkedRecipeId?: string;
  readonly linkSource?: LinkSource;
}

export type Ingredient = MeasuredIngredient | VagueIngredient;

export function isMeasured(i: Ingredient): i is MeasuredIngredient {
  return i.type === 'MEASURED';
}

export interface IngredientRef {
  readonly ingredientId: string;
  /**
   * How much of the ingredient is *consumed* in this step. Optional:
   * when absent, the UI falls back to the ingredient's own quantity
   * (i.e. "use all of it"). Used by Cook Mode to show a per-step
   * measure — e.g. `"2 cup flour"` on step 1 of a recipe that calls
   * for 3 cups total.
   */
  readonly quantity?: Quantity;
}

export function newIngredientId(): string {
  return crypto.randomUUID();
}

export function measured(params: {
  id?: string;
  name: string;
  quantity: Quantity;
  preparation?: string;
  notes?: string;
  linkedRecipeId?: string;
  linkSource?: LinkSource;
}): MeasuredIngredient {
  return {
    type: 'MEASURED',
    id: params.id ?? newIngredientId(),
    name: params.name,
    quantity: params.quantity,
    preparation: params.preparation,
    notes: params.notes,
    linkedRecipeId: params.linkedRecipeId,
    linkSource: params.linkSource,
  };
}

export function vague(params: {
  id?: string;
  name: string;
  preparation?: string;
  notes?: string;
  description?: string;
  linkedRecipeId?: string;
  linkSource?: LinkSource;
}): VagueIngredient {
  return {
    type: 'VAGUE',
    id: params.id ?? newIngredientId(),
    name: params.name,
    preparation: params.preparation,
    notes: params.notes,
    description: params.description,
    linkedRecipeId: params.linkedRecipeId,
    linkSource: params.linkSource,
  };
}
