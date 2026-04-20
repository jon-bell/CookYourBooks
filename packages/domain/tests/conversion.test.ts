import { describe, expect, it } from 'vitest';
import { createRegistry } from '../src/conversion/registry.js';
import { conversionRule } from '../src/conversion/rules.js';

describe('ConversionRegistry', () => {
  it('returns 1 for identity conversions', () => {
    const reg = createRegistry();
    expect(reg.findFactor('cup', 'cup')).toBe(1);
  });

  it('finds standard direct conversions', () => {
    const reg = createRegistry();
    expect(reg.findFactor('tablespoon', 'teaspoon')).toBe(3);
    expect(reg.findFactor('kilogram', 'gram')).toBe(1000);
  });

  it('prefers ingredient-specific rules over generic', () => {
    const reg = createRegistry().withRule(
      conversionRule({
        fromUnit: 'cup',
        toUnit: 'gram',
        factor: 120,
        ingredientName: 'flour',
        priority: 'STANDARD',
      }),
    );
    expect(reg.findFactor('cup', 'gram', 'flour')).toBe(120);
    // No generic gram↔cup in standards, so non-flour lookups return undefined for direct
    expect(reg.findFactor('cup', 'gram', 'sugar')).toBeUndefined();
  });

  it('HOUSE rules beat STANDARD rules', () => {
    const reg = createRegistry().withRule(
      conversionRule({
        fromUnit: 'tablespoon',
        toUnit: 'teaspoon',
        factor: 4, // intentionally wrong to detect override
        priority: 'HOUSE',
      }),
    );
    expect(reg.findFactor('tablespoon', 'teaspoon')).toBe(4);
  });

  it('RECIPE rules beat STANDARD rules but not HOUSE', () => {
    let reg = createRegistry().withRule(
      conversionRule({
        fromUnit: 'tablespoon',
        toUnit: 'teaspoon',
        factor: 5,
        priority: 'RECIPE',
      }),
    );
    expect(reg.findFactor('tablespoon', 'teaspoon')).toBe(5);
    reg = reg.withRule(
      conversionRule({
        fromUnit: 'tablespoon',
        toUnit: 'teaspoon',
        factor: 6,
        priority: 'HOUSE',
      }),
    );
    expect(reg.findFactor('tablespoon', 'teaspoon')).toBe(6);
  });

  it('can find a one-hop conversion', () => {
    const reg = createRegistry();
    // gallon → quart → pint → cup exists; our hop depth is 1, so gallon→cup may not exist.
    // quart → cup via quart→pint→cup (pint→cup is standard at 2)
    // Verify one-hop: quart → cup
    expect(reg.findFactor('quart', 'cup')).toBeCloseTo(4, 5);
  });

  it('withRule returns a new registry without mutating the old', () => {
    const reg = createRegistry();
    const withHouse = reg.withRule(
      conversionRule({ fromUnit: 'a', toUnit: 'b', factor: 2, priority: 'HOUSE' }),
    );
    expect(reg.findFactor('a', 'b')).toBeUndefined();
    expect(withHouse.findFactor('a', 'b')).toBe(2);
  });
});
