import { describe, expect, it } from 'vitest';
import { createRecipe, scaleRecipe } from '../src/model/recipe.js';
import { measured, vague } from '../src/model/ingredient.js';
import { exact, fractional } from '../src/model/quantity.js';
import { servings } from '../src/model/servings.js';
import { instruction } from '../src/model/instruction.js';

describe('Recipe', () => {
  const chocChip = createRecipe({
    title: 'Chocolate Chip Cookies',
    servings: servings(24, 'cookies'),
    ingredients: [
      measured({ id: 'i1', name: 'flour', quantity: exact(2, 'cup') }),
      measured({ id: 'i2', name: 'butter', quantity: fractional(0, 1, 2, 'cup') }),
      vague({ id: 'i3', name: 'salt' }),
    ],
    instructions: [
      instruction({ stepNumber: 1, text: 'Mix dry ingredients.' }),
      instruction({ stepNumber: 2, text: 'Combine wet and dry.' }),
    ],
  });

  it('preserves structure when scaling by 1', () => {
    const out = scaleRecipe(chocChip, 1);
    expect(out.ingredients.length).toBe(3);
    expect(out.servings?.amount).toBe(24);
  });

  it('doubles ingredient amounts when scaling by 2', () => {
    const out = scaleRecipe(chocChip, 2);
    const flour = out.ingredients[0];
    expect(flour?.type).toBe('MEASURED');
    if (flour?.type === 'MEASURED') {
      expect(flour.quantity).toEqual({ type: 'EXACT', amount: 4, unit: 'cup' });
    }
    const butter = out.ingredients[1];
    if (butter?.type === 'MEASURED') {
      expect(butter.quantity).toEqual({ type: 'EXACT', amount: 1, unit: 'cup' });
    }
    expect(out.servings?.amount).toBe(48);
  });

  it('leaves vague ingredients unchanged when scaling', () => {
    const out = scaleRecipe(chocChip, 3);
    const salt = out.ingredients[2];
    expect(salt?.type).toBe('VAGUE');
    expect(salt?.name).toBe('salt');
  });

  it('does not mutate the original recipe', () => {
    scaleRecipe(chocChip, 2);
    const flour = chocChip.ingredients[0];
    if (flour?.type === 'MEASURED') {
      expect(flour.quantity).toEqual({ type: 'EXACT', amount: 2, unit: 'cup' });
    }
  });

  it('rejects invalid scale factors', () => {
    expect(() => scaleRecipe(chocChip, 0)).toThrow();
    expect(() => scaleRecipe(chocChip, -1)).toThrow();
  });
});
