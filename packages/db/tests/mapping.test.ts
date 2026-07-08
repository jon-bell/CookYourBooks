import {
  createPersonalCollection,
  createRecipe,
  exact,
  fractional,
  instruction,
  isMeasured,
  measured,
  servings,
  vague,
} from '@cookyourbooks/domain';
import { describe, expect, it } from 'vitest';

import {
  type CollectionRow,
  collectionToInsert,
  type RecipeRow,
  recipeToInsert,
  rowToCollection,
  rowToRecipe,
} from '../src/mapping.js';

const OWNER = '00000000-0000-0000-0000-0000000000aa';

/** Build a full RecipeRow from the domain recipe (children fold into JSON). */
function toRow(recipe: Parameters<typeof recipeToInsert>[0]): RecipeRow {
  return {
    ...recipeToInsert(recipe, 'col-1', 0),
    created_at: '',
    updated_at: '',
  } as unknown as RecipeRow;
}

describe('collection mapping', () => {
  it('round-trips a personal collection', () => {
    const c = createPersonalCollection({
      id: 'col-1',
      title: 'My Greens',
      description: 'Salads and bowls',
      isPublic: true,
    });
    const insert = collectionToInsert(c, OWNER);
    const row: CollectionRow = {
      ...insert,
      owner_id: OWNER,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      is_public: insert.is_public ?? false,
      author: null,
      isbn: null,
      publisher: null,
      publication_year: null,
      source_url: null,
      date_accessed: null,
      site_name: null,
      notes: null,
      cover_image_path: insert.cover_image_path ?? null,
      forked_from: insert.forked_from ?? null,
      description: insert.description ?? null,
    } as CollectionRow;
    const back = rowToCollection(row, []);
    expect(back.id).toBe('col-1');
    expect(back.sourceType).toBe('PERSONAL');
    expect(back.isPublic).toBe(true);
    if (back.sourceType === 'PERSONAL') {
      expect(back.description).toBe('Salads and bowls');
    }
  });
});

describe('recipe mapping (children folded into JSON)', () => {
  it('round-trips a recipe through recipeToInsert / rowToRecipe', () => {
    const recipe = createRecipe({
      id: 'r-1',
      title: 'Test',
      servings: servings(4, 'bowls'),
      ingredients: [
        measured({ id: 'i-1', name: 'flour', quantity: exact(2, 'cup'), preparation: 'sifted' }),
        measured({ id: 'i-2', name: 'butter', quantity: fractional(0, 1, 2, 'cup') }),
        vague({ id: 'i-3', name: 'salt' }),
      ],
      instructions: [
        instruction({ id: 's-1', stepNumber: 1, text: 'Mix.' }),
        instruction({ id: 's-2', stepNumber: 2, text: 'Bake.' }),
      ],
    });

    const back = rowToRecipe(toRow(recipe));
    expect(back.title).toBe('Test');
    expect(back.servings?.amount).toBe(4);
    expect(back.ingredients).toHaveLength(3);

    const first = back.ingredients[0]!;
    expect(isMeasured(first)).toBe(true);
    if (isMeasured(first)) {
      expect(first.quantity).toEqual({ type: 'EXACT', amount: 2, unit: 'cup' });
      expect(first.preparation).toBe('sifted');
    }
    const second = back.ingredients[1]!;
    if (isMeasured(second)) {
      expect(second.quantity).toEqual({
        type: 'FRACTIONAL',
        whole: 0,
        numerator: 1,
        denominator: 2,
        unit: 'cup',
      });
    }
    expect(back.ingredients[2]?.type).toBe('VAGUE');
    expect(back.instructions).toHaveLength(2);
    expect(back.instructions[0]?.text).toBe('Mix.');
  });

  it('round-trips a recipe sourceUrl', () => {
    const recipe = createRecipe({
      id: 'r-src',
      title: 'From a reel',
      sourceUrl: 'https://www.youtube.com/watch?v=abc123',
    });
    const insert = recipeToInsert(recipe, 'col-1', 0) as RecipeRow & {
      source_url?: string | null;
    };
    expect(insert.source_url).toBe('https://www.youtube.com/watch?v=abc123');
    expect(rowToRecipe(toRow(recipe)).sourceUrl).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('leaves sourceUrl undefined when absent', () => {
    const recipe = createRecipe({ id: 'r-nosrc', title: 'No source' });
    const insert = recipeToInsert(recipe, 'col-1', 0) as RecipeRow & {
      source_url?: string | null;
    };
    expect(insert.source_url).toBeNull();
    expect(rowToRecipe(toRow(recipe)).sourceUrl).toBeUndefined();
  });

  it('round-trips instruction simplifiedSteps through the JSON column', () => {
    const recipe = createRecipe({
      id: 'r-1',
      title: 't',
      instructions: [
        instruction({
          id: 's-1',
          stepNumber: 1,
          text: 'Heat pan, add seeds, toast 2 min.',
          simplifiedSteps: [
            { text: 'Heat pan over medium-high heat' },
            { text: 'Add the seeds to the pan' },
            {
              text: 'Toast the seeds, shaking the pan',
              durationSec: 120,
              temperature: { value: 350, unit: 'FAHRENHEIT' },
              notes: 'do not burn',
            },
          ],
        }),
      ],
    });
    const back = rowToRecipe(toRow(recipe));
    const out = back.instructions[0];
    expect(out?.simplifiedSteps).toHaveLength(3);
    expect(out?.simplifiedSteps?.[2]?.durationSec).toBe(120);
    expect(out?.simplifiedSteps?.[2]?.temperature).toEqual({ value: 350, unit: 'FAHRENHEIT' });
    expect(out?.simplifiedSteps?.[2]?.notes).toBe('do not burn');
  });

  it('drops malformed simplified-step entries silently (local JSON text)', () => {
    const recipeRow = {
      id: 'r-3',
      collection_id: 'c',
      title: 't',
      servings_amount: null,
      servings_description: null,
      sort_order: 0,
      notes: null,
      parent_recipe_id: null,
      created_at: '',
      updated_at: '',
      ingredients: '[]',
      instructions: JSON.stringify([
        {
          id: 's-bad',
          stepNumber: 1,
          text: 'has bad rewrite',
          simplifiedSteps: [
            { text: 'ok step' },
            { text: '' }, // empty → dropped
            { notText: 'no text field' }, // missing → dropped
            { text: 'bad dur', durationSec: 'oops' }, // non-number dur discarded
          ],
        },
      ]),
    } as unknown as RecipeRow;
    const back = rowToRecipe(recipeRow);
    const steps = back.instructions[0]?.simplifiedSteps ?? [];
    expect(steps.map((s) => s.text)).toEqual(['ok step', 'bad dur']);
    expect(steps[1]?.durationSec).toBeUndefined();
  });

  it('treats malformed measured entries as vague (data integrity fallback)', () => {
    const recipeRow = {
      id: 'r-2',
      collection_id: 'c',
      title: 't',
      servings_amount: null,
      servings_description: null,
      sort_order: 0,
      notes: null,
      parent_recipe_id: null,
      created_at: '',
      updated_at: '',
      instructions: '[]',
      ingredients: JSON.stringify([
        { id: 'i', type: 'MEASURED', name: 'mystery', quantity: { type: 'EXACT', unit: 'cup' } },
      ]),
    } as unknown as RecipeRow;
    const back = rowToRecipe(recipeRow);
    expect(back.ingredients[0]?.type).toBe('VAGUE');
  });
});
