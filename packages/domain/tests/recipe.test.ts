import { describe, expect, it } from 'vitest';
import { adaptRecipe, createRecipe, scaleRecipe } from '../src/model/recipe.js';
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

describe('adaptRecipe', () => {
  const base = createRecipe({
    id: 'base-recipe-id',
    title: 'Chocolate Chip Cookies',
    servings: servings(24, 'cookies'),
    ingredients: [
      measured({ id: 'ing-flour', name: 'flour', quantity: exact(2, 'cup') }),
      vague({ id: 'ing-salt', name: 'salt' }),
    ],
    instructions: [
      instruction({
        id: 'step-1',
        stepNumber: 1,
        text: 'Mix dry.',
        ingredientRefs: [{ ingredientId: 'ing-flour' }, { ingredientId: 'ing-salt' }],
      }),
    ],
  });

  it('sets parentRecipeId and mints a fresh recipe id', () => {
    const adapted = adaptRecipe(base);
    expect(adapted.parentRecipeId).toBe('base-recipe-id');
    expect(adapted.id).not.toBe(base.id);
    expect(adapted.title).toBe('Chocolate Chip Cookies (adaptation)');
  });

  it('reassigns ingredient ids and remaps step references', () => {
    const adapted = adaptRecipe(base);
    const flour = adapted.ingredients[0]!;
    const salt = adapted.ingredients[1]!;
    expect(flour.id).not.toBe('ing-flour');
    expect(salt.id).not.toBe('ing-salt');

    const step = adapted.instructions[0]!;
    expect(step.id).not.toBe('step-1');
    expect(step.ingredientRefs.map((r) => r.ingredientId)).toEqual([flour.id, salt.id]);
  });

  it('applies title + notes overrides', () => {
    const adapted = adaptRecipe(base, { title: 'Chewy Cookies', notes: 'less sugar' });
    expect(adapted.title).toBe('Chewy Cookies');
    expect(adapted.notes).toBe('less sugar');
  });

  it('leaves the base recipe untouched', () => {
    adaptRecipe(base);
    expect(base.ingredients[0]!.id).toBe('ing-flour');
    expect(base.instructions[0]!.id).toBe('step-1');
    expect(base.parentRecipeId).toBeUndefined();
  });
});
