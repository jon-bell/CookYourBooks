import { describe, expect, it } from 'vitest';

import { pickTargetDraft, slugTitleScore } from './targetMatch.js';

describe('slugTitleScore', () => {
  it('matches a title that adds a translation around the slug words', () => {
    expect(
      slugTitleScore('minestrone-alla-milanese', 'Vegetable Chowder (Minestrone alla Milanese)'),
    ).toBe(1);
    expect(
      slugTitleScore('curled-omelet-frittata-in-riccioli', 'Curled Omelet (Frittata in riccioli)'),
    ).toBe(1);
  });

  it('is case- and accent-insensitive', () => {
    expect(slugTitleScore('gnocchi', 'GNOCCHI')).toBe(1);
    expect(slugTitleScore('zuppa-sante', 'Zuppa Santè')).toBe(1);
  });
});

describe('pickTargetDraft', () => {
  // What the minestrone scan (printed pp. 10–11) actually returned.
  const drafts = [
    { title: 'Bean Soup' },
    { title: 'Lentil Soup (Zuppa di lenticchie)' },
    { title: 'Vegetable Chowder (Minestrone alla Milanese)' },
    { title: 'Ravioli' },
  ];

  it('picks the folder’s recipe out of the neighbours on its pages', () => {
    expect(pickTargetDraft(drafts, 'minestrone-alla-milanese')).toBe(2);
  });

  it('returns -1 when no draft is the named recipe', () => {
    expect(pickTargetDraft(drafts, 'polenta-pie')).toBe(-1);
    expect(pickTargetDraft([], 'gnocchi')).toBe(-1);
  });

  it('prefers the closest title', () => {
    expect(
      pickTargetDraft([{ title: 'Apple Pie II' }, { title: 'Apple Pie I' }], 'apple-pie-i'),
    ).toBe(1);
  });
});
