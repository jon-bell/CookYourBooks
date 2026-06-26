import { describe, expect, it } from 'vitest';

import type { SearchHit } from './semanticSearch.js';
import { adaptiveFloor, mergeLiteralAndSemantic } from './semanticSearch.js';

function hit(id: string, score?: number): SearchHit {
  return {
    recipeId: id,
    recipeTitle: id,
    collectionId: 'c',
    collectionTitle: 'c',
    sourceType: 'personal',
    isPlaceholder: false,
    ...(score === undefined ? {} : { score }),
  };
}

describe('adaptiveFloor', () => {
  it('cuts within RELATIVE_WINDOW of a high top score', () => {
    // top 0.92 → keep ~0.87+, which trims the compressed-library tail
    expect(adaptiveFloor(0.92)).toBeCloseTo(0.87, 5);
  });

  it('falls back to the absolute backstop for low top scores', () => {
    // top 0.80 → 0.75 would dip below the backstop, so clamp up to it
    expect(adaptiveFloor(0.8)).toBeCloseTo(0.78, 5);
  });

  it('adapts the band per query rather than using one fixed floor', () => {
    // A weaker conceptual query (top 0.84) keeps its own relevant band
    // instead of being judged against the salad query's 0.87 cut.
    expect(adaptiveFloor(0.84)).toBeCloseTo(0.79, 5);
  });
});

describe('mergeLiteralAndSemantic', () => {
  it('ranks literal hits first and dedupes semantic overlaps', () => {
    const literal = [hit('salad-a'), hit('salad-b')];
    const semantic = [hit('salad-a', 0.95), hit('soup', 0.9)];
    const out = mergeLiteralAndSemantic(literal, semantic, 200);
    expect(out.map((h) => h.recipeId)).toEqual(['salad-a', 'salad-b', 'soup']);
  });

  it('degrades to pure semantic when there are no literal matches', () => {
    const semantic = [hit('warming-stew', 0.88), hit('chili', 0.86)];
    const out = mergeLiteralAndSemantic([], semantic, 200);
    expect(out.map((h) => h.recipeId)).toEqual(['warming-stew', 'chili']);
  });

  it('caps the merged result at limit, prioritizing literal', () => {
    const literal = [hit('a'), hit('b'), hit('c')];
    const semantic = [hit('d', 0.9), hit('e', 0.88)];
    expect(mergeLiteralAndSemantic(literal, semantic, 4).map((h) => h.recipeId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});
