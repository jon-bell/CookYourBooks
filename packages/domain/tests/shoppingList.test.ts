import { describe, expect, it } from 'vitest';
import { buildShoppingList } from '../src/services/shoppingList.js';
import { createRecipe } from '../src/model/recipe.js';
import { measured, vague } from '../src/model/ingredient.js';
import { exact } from '../src/model/quantity.js';

describe('buildShoppingList', () => {
  it('aggregates like measured ingredients across recipes', () => {
    const r1 = createRecipe({
      title: 'A',
      ingredients: [measured({ name: 'flour', quantity: exact(2, 'cup') })],
    });
    const r2 = createRecipe({
      title: 'B',
      ingredients: [measured({ name: 'flour', quantity: exact(1, 'cup') })],
    });
    const list = buildShoppingList([r1, r2]);
    expect(list.measured).toHaveLength(1);
    expect(list.measured[0]?.quantityText).toBe('3 cup');
    expect(list.measured[0]?.aggregated).toBe(true);
    expect(list.measured[0]?.sourceRecipeIds).toHaveLength(2);
  });

  it('keeps different units separate', () => {
    const r = createRecipe({
      title: 'A',
      ingredients: [
        measured({ name: 'flour', quantity: exact(2, 'cup') }),
        measured({ name: 'flour', quantity: exact(100, 'gram') }),
      ],
    });
    const list = buildShoppingList([r]);
    expect(list.measured).toHaveLength(2);
  });

  it('groups vague ingredients by name', () => {
    const r1 = createRecipe({ title: 'A', ingredients: [vague({ name: 'salt' })] });
    const r2 = createRecipe({ title: 'B', ingredients: [vague({ name: 'Salt' })] });
    const list = buildShoppingList([r1, r2]);
    expect(list.uncountable).toHaveLength(1);
    expect(list.uncountable[0]?.aggregated).toBe(true);
  });
});
