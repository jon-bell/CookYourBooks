import { describe, expect, it } from 'vitest';

import { isRecipeSortMode, sortByLastMade } from './recipeSort.js';

const items = [
  { id: 'a', title: 'Apple pie' },
  { id: 'b', title: 'Borscht' },
  { id: 'c', title: 'Carbonara' },
];

describe('sortByLastMade', () => {
  it('orders most-recently-made first, never-made last, ties by title', () => {
    const lastMade = new Map([
      ['a', '2026-05-01'],
      ['c', '2026-06-01'],
    ]);
    expect(sortByLastMade(items, lastMade).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('breaks same-day ties by title', () => {
    const lastMade = new Map([
      ['b', '2026-06-01'],
      ['a', '2026-06-01'],
    ]);
    expect(sortByLastMade(items, lastMade).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to pure title order with no map', () => {
    expect(sortByLastMade([...items].reverse(), undefined).map((i) => i.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('does not mutate the input', () => {
    const input = [...items];
    sortByLastMade(input, new Map([['b', '2026-01-01']]));
    expect(input.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('isRecipeSortMode', () => {
  it('accepts the four modes and rejects junk', () => {
    for (const m of ['manual', 'name', 'page', 'made']) {
      expect(isRecipeSortMode(m)).toBe(true);
    }
    expect(isRecipeSortMode('views')).toBe(false);
    expect(isRecipeSortMode('')).toBe(false);
  });
});
