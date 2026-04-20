import type { Recipe } from '../model/recipe.js';
import { formatQuantity } from '../model/quantity.js';
import { isMeasured } from '../model/ingredient.js';
import { formatServings } from '../model/servings.js';

export function recipeToMarkdown(recipe: Recipe): string {
  const lines: string[] = [];
  lines.push(`# ${recipe.title}`);
  lines.push('');
  if (recipe.servings) {
    lines.push(`**Servings:** ${formatServings(recipe.servings)}`);
    lines.push('');
  }
  lines.push('## Ingredients');
  for (const ing of recipe.ingredients) {
    if (isMeasured(ing)) {
      const prep = ing.preparation ? `, ${ing.preparation}` : '';
      lines.push(`- ${formatQuantity(ing.quantity)} ${ing.name}${prep}`);
    } else {
      const prep = ing.preparation ? `, ${ing.preparation}` : '';
      lines.push(`- ${ing.name}${prep}`);
    }
  }
  lines.push('');
  lines.push('## Instructions');
  for (const step of recipe.instructions) {
    lines.push(`${step.stepNumber}. ${step.text}`);
  }
  return lines.join('\n');
}
