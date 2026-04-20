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
}

export type Ingredient = MeasuredIngredient | VagueIngredient;

export function isMeasured(i: Ingredient): i is MeasuredIngredient {
  return i.type === 'MEASURED';
}

export interface IngredientRef {
  readonly ingredientId: string;
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
}): VagueIngredient {
  return {
    type: 'VAGUE',
    id: params.id ?? newIngredientId(),
    name: params.name,
    preparation: params.preparation,
    notes: params.notes,
  };
}
