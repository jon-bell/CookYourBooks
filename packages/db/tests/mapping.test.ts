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
  type IngredientRow,
  ingredientToInsert,
  type InstructionRow,
  instructionToInsert,
  type RecipeRow,
  recipeToInsert,
  rowsToRecipe,
  rowToCollection,
} from '../src/mapping.js';

const OWNER = '00000000-0000-0000-0000-0000000000aa';

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

describe('recipe mapping', () => {
  it('round-trips a recipe through insert/rows', () => {
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

    const recipeRow: RecipeRow = {
      ...recipeToInsert(recipe, 'col-1', 0),
      created_at: '',
      updated_at: '',
      servings_amount: recipe.servings!.amount,
      servings_description: recipe.servings!.description ?? null,
    } as RecipeRow;
    const ingRows: IngredientRow[] = recipe.ingredients.map(
      (ing, i) => ({ ...ingredientToInsert(ing, recipe.id, i), id: ing.id }) as IngredientRow,
    );
    const stepRows: InstructionRow[] = recipe.instructions.map(
      (s) => ({ ...instructionToInsert(s, recipe.id), id: s.id }) as InstructionRow,
    );

    const back = rowsToRecipe(recipeRow, ingRows, stepRows);
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
    const recipeRow = { ...insert, created_at: '', updated_at: '' };
    const back = rowsToRecipe(recipeRow, [], []);
    expect(back.sourceUrl).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('leaves sourceUrl undefined when absent', () => {
    const recipe = createRecipe({ id: 'r-nosrc', title: 'No source' });
    const insert = recipeToInsert(recipe, 'col-1', 0) as RecipeRow & {
      source_url?: string | null;
    };
    expect(insert.source_url).toBeNull();
    const recipeRow = { ...insert, created_at: '', updated_at: '' };
    expect(rowsToRecipe(recipeRow, [], []).sourceUrl).toBeUndefined();
  });

  it('round-trips instruction simplifiedSteps through jsonb', () => {
    const step = instruction({
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
    });
    const insert = instructionToInsert(step, 'r-1') as InstructionRow & {
      simplified_steps?: unknown;
    };
    const row: InstructionRow = {
      ...insert,
      id: step.id,
    };
    const recipeRow = {
      id: 'r-1',
      collection_id: 'c',
      title: 't',
      servings_amount: null,
      servings_description: null,
      sort_order: 0,
      notes: null,
      parent_recipe_id: null,
      created_at: '',
      updated_at: '',
    } as RecipeRow;
    const back = rowsToRecipe(recipeRow, [], [row]);
    const out = back.instructions[0];
    expect(out?.simplifiedSteps).toHaveLength(3);
    expect(out?.simplifiedSteps?.[2]?.durationSec).toBe(120);
    expect(out?.simplifiedSteps?.[2]?.temperature).toEqual({ value: 350, unit: 'FAHRENHEIT' });
    expect(out?.simplifiedSteps?.[2]?.notes).toBe('do not burn');
  });

  it('drops malformed simplified-step entries silently', () => {
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
    } as RecipeRow;
    const badStep = {
      id: 's-bad',
      recipe_id: 'r-3',
      step_number: 1,
      text: 'has bad rewrite',
      temperature_value: null,
      temperature_unit: null,
      sub_instructions: null,
      simplified_steps: JSON.stringify([
        { text: 'ok step' },
        { text: '' }, // empty → dropped
        { notText: 'no text field' }, // missing → dropped
        { text: 'bad dur', durationSec: 'oops' }, // non-number dur retained, but invalid → discarded
      ]),
      notes: null,
    } as unknown as InstructionRow;
    const back = rowsToRecipe(recipeRow, [], [badStep]);
    const steps = back.instructions[0]?.simplifiedSteps ?? [];
    expect(steps.map((s) => s.text)).toEqual(['ok step', 'bad dur']);
    // durationSec must be a positive finite number to be retained.
    expect(steps[1]?.durationSec).toBeUndefined();
  });

  it('treats malformed measured rows as vague (data integrity fallback)', () => {
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
    } as RecipeRow;
    const badIng = {
      id: 'i',
      recipe_id: 'r-2',
      sort_order: 0,
      type: 'MEASURED',
      name: 'mystery',
      preparation: null,
      notes: null,
      quantity_type: 'EXACT',
      quantity_amount: null, // malformed
      quantity_whole: null,
      quantity_numerator: null,
      quantity_denominator: null,
      quantity_min: null,
      quantity_max: null,
      quantity_unit: 'cup',
    } as IngredientRow;
    const back = rowsToRecipe(recipeRow, [badIng], []);
    expect(back.ingredients[0]?.type).toBe('VAGUE');
  });
});
