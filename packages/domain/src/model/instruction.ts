import type { IngredientRef } from './ingredient.js';

export type TemperatureUnit = 'FAHRENHEIT' | 'CELSIUS';

export interface Temperature {
  readonly value: number;
  readonly unit: TemperatureUnit;
}

export interface Instruction {
  readonly id: string;
  readonly stepNumber: number;
  readonly text: string;
  readonly ingredientRefs: readonly IngredientRef[];
  /**
   * Oven / stovetop target for this step, when the source recipe
   * spells one out ("Preheat the oven to 350°F"). Rendered as a small
   * badge on the step card and in Cook Mode.
   */
  readonly temperature?: Temperature;
  /**
   * Bulleted sub-steps within this step — the rich source format often
   * has short clarifying lines ("A. Warm the milk. B. Add yeast.").
   */
  readonly subInstructions?: readonly string[];
  /**
   * Free-form annotation on the step itself — warnings, alternatives,
   * "it should be shaggy, not smooth" hints.
   */
  readonly notes?: string;
}

export function newInstructionId(): string {
  return crypto.randomUUID();
}

export function instruction(params: {
  id?: string;
  stepNumber: number;
  text: string;
  ingredientRefs?: readonly IngredientRef[];
  temperature?: Temperature;
  subInstructions?: readonly string[];
  notes?: string;
}): Instruction {
  return {
    id: params.id ?? newInstructionId(),
    stepNumber: params.stepNumber,
    text: params.text,
    ingredientRefs: [...(params.ingredientRefs ?? [])],
    temperature: params.temperature,
    subInstructions: params.subInstructions ? [...params.subInstructions] : undefined,
    notes: params.notes,
  };
}
