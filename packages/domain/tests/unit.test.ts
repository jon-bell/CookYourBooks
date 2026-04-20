import { describe, expect, it } from 'vitest';
import { findUnit, Units } from '../src/model/unit.js';

describe('Units', () => {
  it('finds units by abbreviation', () => {
    expect(findUnit('tsp')?.name).toBe('teaspoon');
    expect(findUnit('TBSP')?.name).toBe('tablespoon');
    expect(findUnit('oz')?.name).toBe('ounce');
  });

  it('finds units by full name (case insensitive)', () => {
    expect(findUnit('Cup')?.name).toBe('cup');
    expect(findUnit('MILLILITER')?.name).toBe('milliliter');
  });

  it('returns undefined for unknown tokens', () => {
    expect(findUnit('xyz')).toBeUndefined();
  });

  it('has expected system and dimension metadata', () => {
    expect(Units.CUP.system).toBe('IMPERIAL');
    expect(Units.CUP.dimension).toBe('VOLUME');
    expect(Units.GRAM.system).toBe('METRIC');
    expect(Units.PINCH.dimension).toBe('TASTE');
  });
});
