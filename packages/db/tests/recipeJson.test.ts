import {
  createRecipe,
  exact,
  fractional,
  instruction,
  measured,
  range,
  vague,
} from '@cookyourbooks/domain';
import { describe, expect, it } from 'vitest';

import {
  deserializeChildren,
  legacyChildRowsToStored,
  serializeChildren,
} from '../src/recipeJson.js';

// A recipe exercising every Quantity variant, VAGUE-with-description, per-step
// ingredient refs (with + without consumed quantity), sub-instructions and the
// simplifiedSteps sentinel.
const RECIPE = createRecipe({
  id: 'r-1',
  title: 'Everything',
  ingredients: [
    measured({ id: 'i-1', name: 'flour', quantity: exact(2.25, 'cup'), preparation: 'sifted' }),
    measured({ id: 'i-2', name: 'butter', quantity: fractional(1, 1, 2, 'stick'), notes: 'cold' }),
    measured({ id: 'i-3', name: 'water', quantity: range(1, 2, 'cup') }),
    vague({ id: 'i-4', name: 'salt', description: 'to taste' }),
  ],
  instructions: [
    instruction({
      id: 's-1',
      stepNumber: 1,
      text: 'Combine flour and salt.',
      ingredientRefs: [{ ingredientId: 'i-1', quantity: exact(1, 'cup') }, { ingredientId: 'i-4' }],
      subInstructions: ['whisk', 'sift again'],
      notes: 'shaggy not smooth',
    }),
    instruction({
      id: 's-2',
      stepNumber: 2,
      text: 'Toast.',
      temperature: { value: 350, unit: 'FAHRENHEIT' },
      simplifiedSteps: [{ text: 'heat', durationSec: 60 }],
    }),
  ],
});

describe('recipeJson round-trip', () => {
  it('serialize → deserialize preserves ingredients & instructions', () => {
    const stored = serializeChildren(RECIPE);
    const back = deserializeChildren(stored.ingredients, stored.instructions);
    expect(back.ingredients).toEqual([...RECIPE.ingredients]);
    expect(back.instructions).toEqual([...RECIPE.instructions]);
  });

  it('survives a JSON-string round-trip (local-SQLite TEXT path)', () => {
    const stored = serializeChildren(RECIPE);
    const back = deserializeChildren(
      JSON.stringify(stored.ingredients),
      JSON.stringify(stored.instructions),
    );
    expect(back.ingredients).toEqual([...RECIPE.ingredients]);
    expect(back.instructions).toEqual([...RECIPE.instructions]);
  });

  it('tolerates null / empty inputs', () => {
    expect(deserializeChildren(null, undefined)).toEqual({ ingredients: [], instructions: [] });
    expect(deserializeChildren('', '[]')).toEqual({ ingredients: [], instructions: [] });
  });

  it('legacy flat rows fold into the same Stored shape', () => {
    const ingRows = [
      {
        id: 'i-1',
        sort_order: 0,
        type: 'MEASURED',
        name: 'flour',
        preparation: 'sifted',
        quantity_type: 'EXACT',
        quantity_amount: 2.25,
        quantity_unit: 'cup',
      },
      { id: 'i-4', sort_order: 1, type: 'VAGUE', name: 'salt', description: 'to taste' },
    ];
    const instRows = [{ id: 's-1', step_number: 1, text: 'Combine.', temperature_value: null }];
    const refRows = [
      {
        instruction_id: 's-1',
        ingredient_id: 'i-1',
        consumed_quantity_type: 'EXACT',
        consumed_quantity_amount: 1,
        consumed_quantity_unit: 'cup',
      },
    ];
    const stored = legacyChildRowsToStored(ingRows, instRows, refRows);
    // Feeding the folded JSON back through the deserializer yields real domain
    // objects with the expected quantities + refs.
    const back = deserializeChildren(stored.ingredients, stored.instructions);
    expect(back.ingredients[0]).toEqual(
      measured({ id: 'i-1', name: 'flour', quantity: exact(2.25, 'cup'), preparation: 'sifted' }),
    );
    expect(back.ingredients[1]?.type).toBe('VAGUE');
    expect(back.instructions[0]?.ingredientRefs[0]).toEqual({
      ingredientId: 'i-1',
      quantity: exact(1, 'cup'),
    });
  });
});
