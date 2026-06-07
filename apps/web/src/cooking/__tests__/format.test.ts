import { describe, expect, it } from 'vitest';
import { occasionLabel, relativeTime, summarizeAdjustment } from '../format.js';
import type { RecipeAdjustment } from '@cookyourbooks/domain';

describe('summarizeAdjustment', () => {
  it('summarizes each adjustment kind', () => {
    const cases: [RecipeAdjustment, string][] = [
      [
        { type: 'INGREDIENT_SWAP', ingredientId: 'i', fromName: 'butter', toText: 'olive oil' },
        'Swapped butter → olive oil',
      ],
      [{ type: 'INGREDIENT_OMIT', ingredientId: 'i', fromName: 'salt' }, 'Left out salt'],
      [{ type: 'INGREDIENT_ADD', toText: 'chili flakes' }, 'Added chili flakes'],
      [
        { type: 'INSTRUCTION_SWAP', instructionId: 's', stepNumber: 2, fromText: 'x', toText: 'baked it' },
        'Step 2: did "baked it" instead',
      ],
      [{ type: 'INSTRUCTION_SKIP', instructionId: 's', stepNumber: 4, fromText: 'rest' }, 'Skipped step 4'],
    ];
    for (const [adj, expected] of cases) {
      expect(summarizeAdjustment(adj)).toBe(expected);
    }
  });
});

describe('occasionLabel', () => {
  it('maps known categories and falls back to empty for none', () => {
    expect(occasionLabel('CELEBRATION')).toBe('Celebration');
    expect(occasionLabel('MEAL_PREP')).toBe('Meal prep');
    expect(occasionLabel(undefined)).toBe('');
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('formats buckets from seconds to years', () => {
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now - 90 * 1000, now)).toBe('1m ago');
    expect(relativeTime(now - 3 * 3600 * 1000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86400 * 1000, now)).toBe('2d ago');
    expect(relativeTime(now - 14 * 86400 * 1000, now)).toBe('2w ago');
    expect(relativeTime(now - 60 * 86400 * 1000, now)).toBe('2mo ago');
    expect(relativeTime(now - 400 * 86400 * 1000, now)).toBe('1y ago');
  });
});
