import { describe, expect, it } from 'vitest';
import { parseLlmJson } from './llm.js';
import { isMeasured } from '@cookyourbooks/domain';

// These tests pin the JSON-response contract. A model returning a shape
// compatible with what we prompt for must always produce a usable draft;
// malformed fields must be discarded rather than crashing the importer.

describe('parseLlmJson', () => {
  it('parses a well-formed response into a draft', () => {
    const text = JSON.stringify({
      title: 'Pancakes',
      servings: { amount: 4, description: 'pancakes' },
      ingredients: [
        {
          type: 'MEASURED',
          name: 'flour',
          quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
        },
        {
          type: 'MEASURED',
          name: 'butter',
          preparation: 'melted',
          quantity: { type: 'FRACTIONAL', whole: 0, numerator: 1, denominator: 2, unit: 'cup' },
        },
        { type: 'VAGUE', name: 'salt' },
      ],
      instructions: [
        { stepNumber: 1, text: 'Whisk dry ingredients.' },
        { stepNumber: 2, text: 'Cook on a hot griddle.' },
      ],
    });

    const draft = parseLlmJson(text);
    expect(draft.title).toBe('Pancakes');
    expect(draft.servings?.amount).toBe(4);
    expect(draft.ingredients).toHaveLength(3);
    const flour = draft.ingredients[0];
    if (!flour || !isMeasured(flour)) throw new Error('expected measured');
    expect(flour.quantity).toEqual({ type: 'EXACT', amount: 2, unit: 'cup' });
    expect(draft.instructions).toHaveLength(2);
    expect(draft.instructions[1]?.stepNumber).toBe(2);
    expect(draft.leftover).toEqual([]);
  });

  it('strips markdown fences around the JSON payload', () => {
    const text =
      '```json\n' + JSON.stringify({ title: 'x', ingredients: [], instructions: [] }) + '\n```';
    const draft = parseLlmJson(text);
    expect(draft.title).toBe('x');
  });

  it('drops malformed ingredients into leftover instead of throwing', () => {
    const text = JSON.stringify({
      title: 't',
      ingredients: [
        { type: 'MEASURED', name: 'ok', quantity: { type: 'EXACT', amount: 1, unit: 'cup' } },
        { type: 'MEASURED', name: 'bad', quantity: { type: 'EXACT' } }, // missing amount/unit
        { type: 'VAGUE' }, // missing name
      ],
      instructions: [],
    });
    const draft = parseLlmJson(text);
    expect(draft.ingredients).toHaveLength(1);
    expect(draft.leftover.length).toBe(2);
  });

  it('renumbers instructions when stepNumber is missing', () => {
    const text = JSON.stringify({
      ingredients: [],
      instructions: [{ text: 'A' }, { text: 'B' }],
    });
    const draft = parseLlmJson(text);
    expect(draft.instructions.map((i) => i.stepNumber)).toEqual([1, 2]);
  });

  it('throws a helpful error when the text is not JSON', () => {
    expect(() => parseLlmJson('Sorry, I could not read the image.')).toThrow(
      /Could not parse LLM JSON/,
    );
  });
});
