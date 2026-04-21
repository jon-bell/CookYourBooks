import { describe, expect, it } from 'vitest';
import { canonicalUnitName, findUnit, Units } from '../src/model/unit.js';

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

  it('has the new serving + informal units (PEOPLE, HANDFUL)', () => {
    expect(Units.PEOPLE.name).toBe('people');
    expect(Units.PEOPLE.dimension).toBe('COUNT');
    expect(Units.HANDFUL.name).toBe('handful');
    expect(Units.HANDFUL.dimension).toBe('TASTE');
  });
});

describe('canonicalUnitName', () => {
  it('canonicalizes catalog keys (the LLM-prompt style) to lowercase names', () => {
    expect(canonicalUnitName('CUP')).toBe('cup');
    expect(canonicalUnitName('GRAM')).toBe('gram');
    expect(canonicalUnitName('PEOPLE')).toBe('people');
  });

  it('collapses the WHOLE alias to the `piece` catalog entry', () => {
    expect(canonicalUnitName('WHOLE')).toBe('piece');
    expect(canonicalUnitName('whole')).toBe('piece');
  });

  it('resolves abbreviations (tsp → teaspoon)', () => {
    expect(canonicalUnitName('tsp')).toBe('teaspoon');
    expect(canonicalUnitName('kg')).toBe('kilogram');
  });

  it('returns empty string on null / empty input', () => {
    expect(canonicalUnitName(null)).toBe('');
    expect(canonicalUnitName(undefined)).toBe('');
    expect(canonicalUnitName('')).toBe('');
  });

  it('round-trips unknown tokens unchanged so data is never destroyed', () => {
    expect(canonicalUnitName('stick')).toBe('stick');
  });
});
