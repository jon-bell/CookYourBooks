import type { IngredientRef } from './ingredient.js';

export interface Instruction {
  readonly id: string;
  readonly stepNumber: number;
  readonly text: string;
  readonly ingredientRefs: readonly IngredientRef[];
}

export function newInstructionId(): string {
  return crypto.randomUUID();
}

export function instruction(params: {
  id?: string;
  stepNumber: number;
  text: string;
  ingredientRefs?: readonly IngredientRef[];
}): Instruction {
  return {
    id: params.id ?? newInstructionId(),
    stepNumber: params.stepNumber,
    text: params.text,
    ingredientRefs: [...(params.ingredientRefs ?? [])],
  };
}
