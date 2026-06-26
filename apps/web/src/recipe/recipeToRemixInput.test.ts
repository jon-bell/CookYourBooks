import { createRecipe, exact, instruction, measured, vague } from '@cookyourbooks/domain';
import { describe, expect, it } from 'vitest';

import { recipeToRemixInput } from './recipeToRemixInput.js';

describe('recipeToRemixInput', () => {
  it('flattens a recipe into readable strings the LLM can transform', () => {
    const recipe = createRecipe({
      title: 'Beef Stew',
      servings: { amount: 4, description: 'people' },
      ingredients: [
        measured({ name: 'beef chuck', quantity: exact(500, 'GRAM'), preparation: 'cubed' }),
        vague({ name: 'salt', description: 'to taste' }),
      ],
      instructions: [
        instruction({ stepNumber: 1, text: 'Brown the beef.', ingredientRefs: [] }),
        instruction({ stepNumber: 2, text: 'Simmer 2 hours.', ingredientRefs: [] }),
      ],
    });

    const input = recipeToRemixInput(recipe);
    expect(input.title).toBe('Beef Stew');
    expect(input.servings).toMatch(/4/);
    expect(input.ingredients).toHaveLength(2);
    expect(input.ingredients[0]).toContain('beef chuck');
    expect(input.ingredients[0]).toContain('cubed');
    expect(input.ingredients[1]).toContain('salt');
    expect(input.instructions).toEqual(['Brown the beef.', 'Simmer 2 hours.']);
  });

  it('returns a JSON object (not a string) so it satisfies the worker input contract', () => {
    const recipe = createRecipe({ title: 'X', ingredients: [], instructions: [] });
    const input = recipeToRemixInput(recipe);
    expect(typeof input).toBe('object');
    expect(Array.isArray(input.ingredients)).toBe(true);
  });

  it('falls back to "Untitled" when the title is blank', () => {
    const input = recipeToRemixInput({ title: '   ', ingredients: [], instructions: [] });
    expect(input.title).toBe('Untitled');
  });
});
