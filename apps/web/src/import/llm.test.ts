import { describe, expect, it } from 'vitest';
import { parseLlmJson } from './llm.js';
import { isMeasured } from '@cookyourbooks/domain';

// These tests pin the JSON-response contract. The parser is deliberately
// lenient — it accepts both the rich prompt's lowercase-typed multi-recipe
// wrapper and the legacy single-recipe shape, and canonicalizes units on
// the way in. Malformed sub-entries get quarantined in `leftover` rather
// than throwing.

describe('parseLlmJson', () => {
  it('parses the rich prompt shape with a single wrapped recipe', () => {
    const text = JSON.stringify({
      recipes: [
        {
          title: 'Simple Pancakes',
          pageNumbers: [42],
          bookTitle: 'Breakfast Classics',
          yield: { type: 'exact', value: 4, unit: 'PEOPLE' },
          timeEstimate: '30 minutes',
          equipment: ['stand mixer', 'baking sheet'],
          description: 'A weekend staple.',
          ingredients: [
            {
              type: 'measured',
              name: 'flour',
              quantity: { type: 'exact', value: 250, unit: 'GRAM' },
            },
            {
              type: 'measured',
              name: 'sugar',
              quantity: {
                type: 'fractional',
                whole: 0,
                numerator: 1,
                denominator: 2,
                unit: 'CUP',
              },
            },
            {
              type: 'vague',
              name: 'salt',
              description: 'to taste',
            },
          ],
          instructions: [
            {
              stepNumber: 1,
              text: 'Mix 200 g flour with the sugar.',
              consumedIngredients: [
                {
                  ingredientName: 'flour',
                  quantity: { type: 'exact', value: 200, unit: 'GRAM' },
                },
                { ingredientName: 'sugar' },
              ],
            },
            {
              stepNumber: 2,
              text: 'Season.',
              consumedIngredients: [{ ingredientName: 'salt', vague: true }],
              temperature: { value: 350, unit: 'FAHRENHEIT' },
              subInstructions: ['Taste and adjust.', 'Add more salt if needed.'],
              notes: 'Go light to start.',
            },
          ],
        },
      ],
      rawText: 'Simple Pancakes — serves 4.',
    });

    const drafts = parseLlmJson(text);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.title).toBe('Simple Pancakes');
    expect(d.pageNumbers).toEqual([42]);
    expect(d.bookTitle).toBe('Breakfast Classics');
    expect(d.timeEstimate).toBe('30 minutes');
    expect(d.equipment).toEqual(['stand mixer', 'baking sheet']);
    expect(d.description).toBe('A weekend staple.');
    expect(d.sourceImageText).toBe('Simple Pancakes — serves 4.');

    // `yield.unit = PEOPLE` canonicalizes to the "people" description,
    // amount=4, no range.
    expect(d.servings).toEqual({ amount: 4, description: 'people', amountMax: undefined });

    // Measured / vague + canonicalized unit names.
    const [flour, sugar, salt] = d.ingredients;
    expect(isMeasured(flour!)).toBe(true);
    if (isMeasured(flour!)) {
      expect(flour.quantity).toEqual({ type: 'EXACT', amount: 250, unit: 'gram' });
    }
    if (isMeasured(sugar!)) {
      expect(sugar.quantity).toEqual({
        type: 'FRACTIONAL',
        whole: 0,
        numerator: 1,
        denominator: 2,
        unit: 'cup',
      });
    }
    expect(salt?.type).toBe('VAGUE');
    if (salt?.type === 'VAGUE') expect(salt.description).toBe('to taste');

    // Step 1: two consumed refs, flour with a per-step quantity.
    const step1 = d.instructions[0]!;
    const flourRef = step1.ingredientRefs.find((r) => r.ingredientId === flour!.id);
    expect(flourRef?.quantity).toEqual({ type: 'EXACT', amount: 200, unit: 'gram' });
    const sugarRef = step1.ingredientRefs.find((r) => r.ingredientId === sugar!.id);
    expect(sugarRef).toBeDefined();
    expect(sugarRef?.quantity).toBeUndefined();

    // Step 2: temperature + sub-instructions + notes preserved.
    const step2 = d.instructions[1]!;
    expect(step2.temperature).toEqual({ value: 350, unit: 'FAHRENHEIT' });
    expect(step2.subInstructions).toEqual(['Taste and adjust.', 'Add more salt if needed.']);
    expect(step2.notes).toBe('Go light to start.');
  });

  it('returns an array with one draft per recipe on a multi-recipe page', () => {
    const text = JSON.stringify({
      recipes: [
        { title: 'A', ingredients: [], instructions: [] },
        { title: 'B', ingredients: [], instructions: [] },
      ],
    });
    const drafts = parseLlmJson(text);
    expect(drafts.map((d) => d.title)).toEqual(['A', 'B']);
  });

  it('still accepts the legacy single-recipe shape at the root', () => {
    const text = JSON.stringify({
      title: 'Legacy Recipe',
      servings: { amount: 2, description: 'people' },
      ingredients: [
        {
          type: 'MEASURED',
          name: 'flour',
          quantity: { type: 'EXACT', amount: 1, unit: 'cup' },
        },
      ],
      instructions: [{ stepNumber: 1, text: 'Mix.' }],
    });
    const drafts = parseLlmJson(text);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toBe('Legacy Recipe');
    expect(drafts[0]!.servings?.amount).toBe(2);
  });

  it('canonicalizes units (catalog keys + aliases) to lowercase names', () => {
    const text = JSON.stringify({
      recipes: [
        {
          title: 'Unit mix',
          ingredients: [
            {
              type: 'measured',
              name: 'flour',
              quantity: { type: 'exact', value: 1, unit: 'CUP' },
            },
            {
              type: 'measured',
              name: 'salt',
              quantity: { type: 'exact', value: 1, unit: 'tsp' },
            },
            {
              type: 'measured',
              name: 'eggs',
              quantity: { type: 'exact', value: 3, unit: 'WHOLE' },
            },
          ],
          instructions: [],
        },
      ],
    });
    const d = parseLlmJson(text)[0]!;
    const units = d.ingredients.map((i) => (isMeasured(i) ? i.quantity.unit : null));
    // CUP -> cup, tsp -> teaspoon (abbreviation), WHOLE -> piece (alias).
    expect(units).toEqual(['cup', 'teaspoon', 'piece']);
  });

  it('parses a range yield into servings with amountMax', () => {
    const text = JSON.stringify({
      recipes: [
        {
          title: 'r',
          yield: { type: 'range', min: 4, max: 6, unit: 'PEOPLE' },
          ingredients: [],
          instructions: [],
        },
      ],
    });
    const d = parseLlmJson(text)[0]!;
    expect(d.servings).toEqual({ amount: 4, amountMax: 6, description: 'people' });
  });

  it('quarantines malformed ingredients into leftover', () => {
    const text = JSON.stringify({
      recipes: [
        {
          title: 'Broken',
          ingredients: [
            { type: 'measured', name: 'good', quantity: { type: 'exact', value: 1, unit: 'cup' } },
            { type: 'measured' /* no name */ },
            { type: 'measured', name: 'bad', quantity: { type: 'range', min: 5, max: 2, unit: 'cup' } },
          ],
          instructions: [],
        },
      ],
    });
    const d = parseLlmJson(text)[0]!;
    expect(d.ingredients.map((i) => i.name)).toEqual(['good', 'bad']);
    // "bad" fell back to vague because the range was invalid.
    expect(d.ingredients[1]!.type).toBe('VAGUE');
    expect(d.leftover).toHaveLength(1);
  });

  it('matches consumedIngredients by substring ("flour" matches "all-purpose flour")', () => {
    const text = JSON.stringify({
      recipes: [
        {
          title: 'Cookies',
          ingredients: [
            {
              type: 'measured',
              name: 'all-purpose flour',
              quantity: { type: 'exact', value: 2, unit: 'CUP' },
            },
          ],
          instructions: [
            {
              stepNumber: 1,
              text: 'Measure flour.',
              consumedIngredients: [
                {
                  ingredientName: 'flour',
                  quantity: { type: 'exact', value: 2, unit: 'CUP' },
                },
              ],
            },
          ],
        },
      ],
    });
    const d = parseLlmJson(text)[0]!;
    const step = d.instructions[0]!;
    expect(step.ingredientRefs).toHaveLength(1);
    expect(step.ingredientRefs[0]!.ingredientId).toBe(d.ingredients[0]!.id);
  });

  it('never crashes on truly empty input, returns a blank draft', () => {
    const drafts = parseLlmJson('{}');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.ingredients).toEqual([]);
    expect(drafts[0]!.instructions).toEqual([]);
  });

  it('tolerates JSON wrapped in ```json … ``` fences', () => {
    const text = '```json\n{"recipes":[{"title":"Fenced","ingredients":[],"instructions":[]}]}\n```';
    const d = parseLlmJson(text)[0]!;
    expect(d.title).toBe('Fenced');
  });
});
