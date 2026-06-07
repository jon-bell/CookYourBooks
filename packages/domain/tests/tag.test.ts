import { describe, expect, it } from 'vitest';
import { createTag, normalizeLabel } from '../src/model/tag.js';

describe('normalizeLabel', () => {
  it('trims, collapses internal whitespace, and lowercases', () => {
    expect(normalizeLabel('  Weeknight ')).toBe('weeknight');
    expect(normalizeLabel('Quick   Dinner')).toBe('quick dinner');
    expect(normalizeLabel('GLUTEN-FREE')).toBe('gluten-free');
  });
});

describe('createTag', () => {
  it('normalizes the label and mints an id', () => {
    const t = createTag({ recipeId: 'r1', label: '  Weeknight ' });
    expect(t.label).toBe('weeknight');
    expect(t.recipeId).toBe('r1');
    expect(t.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('honors an explicit id', () => {
    const t = createTag({ id: 'fixed', recipeId: 'r1', label: 'vegan' });
    expect(t.id).toBe('fixed');
  });

  it('throws on an empty/whitespace label', () => {
    expect(() => createTag({ recipeId: 'r1', label: '   ' })).toThrow();
  });
});
