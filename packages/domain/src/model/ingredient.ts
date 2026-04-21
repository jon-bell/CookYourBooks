import type { Quantity } from './quantity.js';

export interface MeasuredIngredient {
  readonly type: 'MEASURED';
  readonly id: string;
  readonly name: string;
  readonly quantity: Quantity;
  readonly preparation?: string;
  readonly notes?: string;
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
}): MeasuredIngredient {
  return {
    type: 'MEASURED',
    id: params.id ?? newIngredientId(),
    name: params.name,
    quantity: params.quantity,
    preparation: params.preparation,
    notes: params.notes,
  };
}

export function vague(params: {
  id?: string;
  name: string;
  preparation?: string;
  notes?: string;
  description?: string;
}): VagueIngredient {
  return {
    type: 'VAGUE',
    id: params.id ?? newIngredientId(),
    name: params.name,
    preparation: params.preparation,
    notes: params.notes,
    description: params.description,
  };
}
