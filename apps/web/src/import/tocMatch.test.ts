import { describe, expect, it } from 'vitest';

import type { ImportTocEntry } from './model.js';
import { scoreTocMatch, suggestTocMatches } from './tocMatch.js';

function entry(title: string, pageNumber: number | null = null, id = title): ImportTocEntry {
  return {
    id,
    batchId: 'b',
    itemId: 'i',
    ownerId: 'o',
    title,
    pageNumber,
    confidence: 1,
    updatedAt: 0,
  };
}

describe('scoreTocMatch', () => {
  it('returns 1 for an exact normalized match', () => {
    expect(scoreTocMatch('Chocolate Chip Cookies', 'chocolate chip cookies')).toBe(1);
  });

  it('ignores case and most punctuation', () => {
    expect(scoreTocMatch('Chocolate-Chip Cookies!', 'chocolate chip cookies')).toBe(1);
  });

  it('scores substring containment highly', () => {
    expect(scoreTocMatch('Cookies', 'Chocolate Chip Cookies')).toBeGreaterThan(0.6);
  });

  it('scores entirely unrelated titles low', () => {
    expect(scoreTocMatch('Pumpkin Pie', 'Beef Wellington')).toBeLessThan(0.4);
  });

  it('returns 0 for empty input', () => {
    expect(scoreTocMatch('', 'anything')).toBe(0);
    expect(scoreTocMatch('anything', '')).toBe(0);
  });
});

describe('suggestTocMatches', () => {
  const entries: ImportTocEntry[] = [
    entry('Chocolate Chip Cookies', 14, 'a'),
    entry('Oatmeal Raisin Cookies', 18, 'b'),
    entry('Beef Wellington', 92, 'c'),
    entry('Chocolate Mousse', 110, 'd'),
  ];

  it('ranks the best match first', () => {
    const out = suggestTocMatches('chocolate chip cookies', entries);
    expect(out[0]?.entry.id).toBe('a');
  });

  it('filters by minimum score', () => {
    const out = suggestTocMatches('Beef Wellington', entries, { minScore: 0.9 });
    expect(out.length).toBe(1);
    expect(out[0]?.entry.id).toBe('c');
  });

  it('respects the limit', () => {
    const out = suggestTocMatches('cookies', entries, { limit: 1 });
    expect(out.length).toBe(1);
  });

  it('tie-breaks on page number ascending', () => {
    const a = entry('Cookies', 50, 'first');
    const b = entry('Cookies', 25, 'second');
    const out = suggestTocMatches('cookies', [a, b]);
    expect(out[0]?.entry.id).toBe('second');
  });
});
