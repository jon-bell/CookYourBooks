import {
  formatQuantity,
  formatServings,
  type Ingredient,
  type Instruction,
  isMeasured,
  type Servings,
} from '@cookyourbooks/domain';

export interface RemixInput {
  title: string;
  servings?: string;
  ingredients: string[];
  instructions: string[];
}

/**
 * Compact, readable JSON representation of a recipe (or a remix draft) for
 * the LLM to transform. Works for both a domain `Recipe` and a
 * `ParsedRecipeDraft` since both carry title / servings / ingredients /
 * instructions — so turn 1 (the source recipe) and chat follow-ups (the
 * prior draft) go through one path.
 *
 * The OUTPUT schema is defined by the remix system prompt; this is only
 * input context, so a flat readable shape beats the noisy full domain object
 * (ids, refs, simplifiedSteps…). Returns an object (not a string) because the
 * worker requires `input_recipe_json` to be a JSON object.
 */
export function recipeToRemixInput(src: {
  title?: string;
  servings?: Servings;
  ingredients: readonly Ingredient[];
  instructions: readonly Instruction[];
}): RemixInput {
  return {
    title: src.title?.trim() || 'Untitled',
    servings: src.servings ? formatServings(src.servings) : undefined,
    ingredients: src.ingredients.map((ing) => {
      const prep = ing.preparation ? `, ${ing.preparation}` : '';
      if (isMeasured(ing)) {
        return `${formatQuantity(ing.quantity)} ${ing.name}${prep}`.trim();
      }
      const desc = ing.description ? ` (${ing.description})` : '';
      return `${ing.name}${desc}${prep}`.trim();
    }),
    instructions: src.instructions.map((s) => s.text),
  };
}
