import { describe, expect, it } from 'vitest';

import {
  countDuplicates,
  type DedupRecipe,
  findDuplicateClusters,
  titleSimilarity,
  titleTokens,
} from './recipeDedup.js';

function rec(
  id: string,
  title: string,
  firstPage: number | null,
  hasContent: boolean,
  completeness = hasContent ? 10 : 0,
): DedupRecipe {
  return { id, title, firstPage, hasContent, completeness };
}

describe('titleSimilarity', () => {
  it('treats reordered bilingual variants as the same (where levenshtein fails)', () => {
    // "Italian / English" filled row vs "English (italian)" placeholder — same
    // words, different order → identical token sets.
    const a = titleTokens('Baccalà al Pomodoro / Salt Cod in Tomato Sauce');
    const b = titleTokens('Salt cod in tomato sauce (Baccalà al pomodoro)');
    expect(titleSimilarity(a, b)).toBe(1);
  });

  it('rewards an English-only row that is a subset of its bilingual placeholder', () => {
    const filled = titleTokens('Chicken Meatloaf');
    const placeholder = titleTokens('POLPETTONE DI POLLO Chicken Meatloaf');
    expect(titleSimilarity(filled, placeholder)).toBeGreaterThanOrEqual(0.6);
  });

  it('keeps distinct recipes that merely share a common word apart', () => {
    const beef = titleTokens('Beef broth (Brodo di manzo)');
    const chicken = titleTokens('Chicken broth (Brodo di pollo)');
    expect(titleSimilarity(beef, chicken)).toBeLessThan(0.6);
  });

  it('does not let a single shared word (Bread) swallow a longer title', () => {
    expect(
      titleSimilarity(titleTokens('Bread'), titleTokens('Bread pudding with zabaione')),
    ).toBeLessThan(0.6);
  });
});

describe('findDuplicateClusters', () => {
  it('collapses a bilingual triple onto the filled recipe', () => {
    const clusters = findDuplicateClusters([
      rec('a', 'Chicken Meatloaf', 146, true, 12),
      rec('b', 'POLPETTONE DI POLLO Chicken Meatloaf', 146, false),
      rec('c', 'Chicken meatloaf (Polpettone di pollo)', 146, false),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.survivor.id).toBe('a');
    expect(clusters[0]!.duplicates.map((d) => d.id).sort()).toEqual(['b', 'c']);
  });

  it('separates distinct recipes sharing a page (p78: one soup, three broths)', () => {
    const clusters = findDuplicateClusters([
      rec('soup1', 'Passover Egg Soup', 78, true, 8),
      rec('soup2', 'DAYENU / Passover Egg Soup', 78, false),
      rec('soup3', 'Passover egg soup (Dayenu)', 78, false),
      rec('broth1', 'Beef broth (Brodo di manzo)', 78, false),
      rec('broth2', 'Chicken broth (Brodo di pollo)', 78, false),
      rec('broth3', 'Vegetable broth (Brodo vegetale)', 78, false),
    ]);
    // Only the soup collapses; the three broths stay as distinct singletons.
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.survivor.id).toBe('soup1');
    expect(clusters[0]!.duplicates.map((d) => d.id).sort()).toEqual(['soup2', 'soup3']);
    expect(countDuplicates(clusters)).toBe(2);
  });

  it('folds duplicate filled rows AND the placeholder together (p163)', () => {
    const clusters = findDuplicateClusters([
      rec('f1', 'Baccalà al Pomodoro / Salt Cod in Tomato Sauce', 163, true, 14),
      rec('f2', 'Baccalà al Pomodoro / Salt Cod in Tomato Sauce', 163, true, 14),
      rec('f3', 'BACCALÀ AL POMODORO / Salt Cod in Tomato Sauce', 163, true, 13),
      rec('p1', 'Salt cod in tomato sauce (Baccalà al pomodoro)', 163, false),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.survivor.hasContent).toBe(true);
    expect(clusters[0]!.duplicates).toHaveLength(3);
    expect(clusters[0]!.duplicates.some((d) => d.id === 'p1')).toBe(true);
  });

  it('never merges across different pages', () => {
    expect(
      findDuplicateClusters([
        rec('x', 'Chicken Meatloaf', 146, true, 10),
        rec('y', 'Chicken Meatloaf', 200, true, 10),
      ]),
    ).toHaveLength(0);
  });

  it('leaves page-less rows (section headers) untouched', () => {
    expect(
      findDuplicateClusters([rec('x', 'Bread', null, false), rec('y', 'Bread', null, false)]),
    ).toHaveLength(0);
  });

  it('keeps the more complete of two identical filled rows as survivor', () => {
    const clusters = findDuplicateClusters([
      rec('a', 'Tuna Loaf', 162, true, 10),
      rec('b', 'Tuna Loaf', 162, true, 9),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.survivor.id).toBe('a');
    expect(clusters[0]!.duplicates.map((d) => d.id)).toEqual(['b']);
  });
});
