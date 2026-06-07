import { describe, expect, it } from 'vitest';
import {
  logCook,
  markCooked,
  planCook,
  snapshotOfRecipe,
  type RecipeAdjustment,
} from '../src/model/cookingEvent.js';
import { createRecipe } from '../src/model/recipe.js';
import { measured, vague } from '../src/model/ingredient.js';
import { instruction } from '../src/model/instruction.js';
import { exact } from '../src/model/quantity.js';

function sampleRecipe() {
  return createRecipe({
    title: 'Pancakes',
    ingredients: [
      measured({ name: 'flour', quantity: exact(2, 'cup'), preparation: 'sifted' }),
      vague({ name: 'salt', description: 'to taste' }),
    ],
    instructions: [
      instruction({ stepNumber: 1, text: 'Mix dry ingredients.' }),
      instruction({ stepNumber: 2, text: 'Cook on a griddle.' }),
    ],
  });
}

describe('planCook', () => {
  it('creates a PLANNED event with no snapshot and a generated id', () => {
    const e = planCook({ recipeId: 'r1', eventDate: '2026-07-01' });
    expect(e.status).toBe('PLANNED');
    expect(e.recipeId).toBe('r1');
    expect(e.eventDate).toBe('2026-07-01');
    expect(e.recipeSnapshot).toBeUndefined();
    expect(e.adjustments).toEqual([]);
    expect(e.photoPaths).toEqual([]);
    expect(e.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('defensively copies adjustments', () => {
    const adjustments: RecipeAdjustment[] = [
      { type: 'INGREDIENT_OMIT', ingredientId: 'i1', fromName: 'salt' },
    ];
    const e = planCook({ recipeId: 'r1', eventDate: '2026-07-01', adjustments });
    adjustments.push({ type: 'INGREDIENT_ADD', toText: 'chili' });
    expect(e.adjustments).toHaveLength(1);
  });
});

describe('snapshotOfRecipe', () => {
  it('captures title, ingredient quantities/prep, and steps; omits OCR metadata', () => {
    const snap = snapshotOfRecipe(sampleRecipe());
    expect(snap.title).toBe('Pancakes');
    expect(snap.ingredients).toEqual([
      { name: 'flour', quantityText: '2 cup', preparation: 'sifted' },
      { name: 'salt', quantityText: undefined, preparation: undefined },
    ]);
    expect(snap.instructions).toEqual([
      { stepNumber: 1, text: 'Mix dry ingredients.' },
      { stepNumber: 2, text: 'Cook on a griddle.' },
    ]);
  });
});

describe('logCook', () => {
  it('creates a COOKED event carrying the snapshot', () => {
    const snap = snapshotOfRecipe(sampleRecipe());
    const e = logCook({
      recipeId: 'r1',
      eventDate: '2026-06-01',
      snapshot: snap,
      photoPaths: ['u1/e1/a.jpg'],
    });
    expect(e.status).toBe('COOKED');
    expect(e.recipeSnapshot).toBe(snap);
    expect(e.photoPaths).toEqual(['u1/e1/a.jpg']);
  });
});

describe('markCooked', () => {
  it('transitions PLANNED -> COOKED immutably, leaving the input untouched', () => {
    const planned = planCook({ recipeId: 'r1', eventDate: '2026-07-01', notes: 'try it' });
    const snap = snapshotOfRecipe(sampleRecipe());
    const cooked = markCooked(planned, snap);

    expect(planned.status).toBe('PLANNED');
    expect(planned.recipeSnapshot).toBeUndefined();
    expect(cooked).not.toBe(planned);
    expect(cooked.status).toBe('COOKED');
    expect(cooked.recipeSnapshot).toBe(snap);
    expect(cooked.notes).toBe('try it');
    expect(cooked.id).toBe(planned.id);
  });
});
