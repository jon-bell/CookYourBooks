import { describe, expect, it } from 'vitest';
import { parseRecipeText } from '../src/services/parseRecipeText.js';
import { isMeasured } from '../src/model/ingredient.js';

describe('parseRecipeText', () => {
  it('extracts title, servings, ingredients, and instructions from a well-formed recipe', () => {
    const input = `Classic Pancakes
Serves 4

Ingredients
- 2 cups flour
- 1 1/2 tsp baking powder
- salt to taste

Instructions
1. Whisk dry ingredients.
2. Combine with wet ingredients.
3. Cook on a hot griddle until bubbly.
`;
    const out = parseRecipeText(input);
    expect(out.title).toBe('Classic Pancakes');
    expect(out.servings?.amount).toBe(4);
    expect(out.ingredients).toHaveLength(3);
    expect(out.ingredients[0]?.type).toBe('MEASURED');
    const flour = out.ingredients[0];
    if (flour && isMeasured(flour)) {
      expect(flour.name).toBe('flour');
      expect(flour.quantity).toEqual({ type: 'EXACT', amount: 2, unit: 'cup' });
    }
    expect(out.instructions).toHaveLength(3);
    expect(out.instructions[0]?.text).toBe('Whisk dry ingredients.');
    expect(out.instructions[0]?.stepNumber).toBe(1);
    expect(out.leftover).toEqual([]);
  });

  it('recognises Directions / Method headings', () => {
    const out = parseRecipeText(`Tea
Method
Boil water.`);
    expect(out.instructions[0]?.text).toBe('Boil water.');
  });

  it('parses a servings range as the midpoint', () => {
    const out = parseRecipeText(`Soup
Serves 4-6

Ingredients
- 1 cup broth`);
    expect(out.servings?.amount).toBe(5);
  });

  it('falls back to a heuristic split when no headings are present', () => {
    const input = `Quick Salad
2 cups spinach
1 tbsp olive oil
Toss gently and serve immediately with cracked pepper.`;
    const out = parseRecipeText(input);
    expect(out.title).toBe('Quick Salad');
    expect(out.ingredients).toHaveLength(2);
    expect(out.instructions).toHaveLength(1);
    expect(out.instructions[0]?.text).toMatch(/Toss/);
  });

  it('strips "Step 1:" and "1)" prefixes from instructions', () => {
    const out = parseRecipeText(`Thing
Instructions
Step 1: Chop.
2) Cook.`);
    expect(out.instructions.map((s) => s.text)).toEqual(['Chop.', 'Cook.']);
    expect(out.instructions.map((s) => s.stepNumber)).toEqual([1, 2]);
  });

  it('keeps unparseable lines in leftover so the UI can show them', () => {
    const out = parseRecipeText(`My Recipe
Note: chef's kiss required.

Ingredients
garbage that isn't an ingredient

Instructions
Mix.`);
    expect(out.leftover.length).toBeGreaterThan(0);
    expect(out.instructions[0]?.text).toBe('Mix.');
  });

  it('handles markdown-style headings', () => {
    const out = parseRecipeText(`# Toast

## Ingredients
- 1 slice bread

## Instructions
Toast the bread.`);
    expect(out.title).toBe('# Toast');
    expect(out.ingredients).toHaveLength(1);
    expect(out.instructions).toHaveLength(1);
  });
});
