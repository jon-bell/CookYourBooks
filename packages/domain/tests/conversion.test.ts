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

  it('GLOBAL priority beats STANDARD but loses to HOUSE and RECIPE', () => {
    let reg = createRegistry().withRule(
      conversionRule({
        fromUnit: 'tablespoon',
        toUnit: 'teaspoon',
        factor: 3.5,
        priority: 'GLOBAL',
      }),
    );
    expect(reg.findFactor('tablespoon', 'teaspoon')).toBe(3.5);
    reg = reg.withRule(
      conversionRule({
        fromUnit: 'tablespoon',
        toUnit: 'teaspoon',
        factor: 3.6,
        priority: 'RECIPE',
      }),
    );
    expect(reg.findFactor('tablespoon', 'teaspoon')).toBe(3.6);
    reg = reg.withRule(
      conversionRule({
        fromUnit: 'tablespoon',
        toUnit: 'teaspoon',
        factor: 3.7,
        priority: 'HOUSE',
      }),
    );
    expect(reg.findFactor('tablespoon', 'teaspoon')).toBe(3.7);
  });

  it('inverts rules automatically (1 piece onion = 240 g implies 1 g = 1/240 piece)', () => {
    const reg = createRegistry().withRule(
      conversionRule({
        fromUnit: 'piece',
        toUnit: 'gram',
        factor: 240,
        ingredientName: 'onion',
        priority: 'HOUSE',
      }),
    );
    expect(reg.findFactor('piece', 'gram', 'onion')).toBe(240);
    expect(reg.findFactor('gram', 'piece', 'onion')).toBeCloseTo(1 / 240, 8);
    // Inverse must not pollute generic lookups when the rule is
    // ingredient-specific.
    expect(reg.findFactor('gram', 'piece', 'carrot')).toBeUndefined();
  });

  it('inverse lookup preserves the original rule priority', () => {
    let reg = createRegistry()
      .withRule(
        // A GLOBAL ml → g rule (water density seeded by the admin).
        conversionRule({
          fromUnit: 'milliliter',
          toUnit: 'gram',
          factor: 1,
          ingredientName: 'water',
          priority: 'GLOBAL',
        }),
      )
      .withRule(
        // The same user overrode it slightly (their kitchen scale runs hot).
        conversionRule({
          fromUnit: 'milliliter',
          toUnit: 'gram',
          factor: 1.01,
          ingredientName: 'water',
          priority: 'HOUSE',
        }),
      );
    // Forward: HOUSE wins.
    expect(reg.findFactor('milliliter', 'gram', 'water')).toBe(1.01);
    // Inverse: HOUSE inverse wins over GLOBAL inverse.
    expect(reg.findFactor('gram', 'milliliter', 'water')).toBeCloseTo(1 / 1.01, 8);
  });

  it('chains cup → milliliter → gram via a seeded density', () => {
    const reg = createRegistry().withRule(
      // Admin-seeded water density: 1 ml = 1 g.
      conversionRule({
        fromUnit: 'milliliter',
        toUnit: 'gram',
        factor: 1.0,
        ingredientName: 'water',
        priority: 'GLOBAL',
      }),
    );
    // 1 cup = 236.588 ml (STANDARD), 1 ml water = 1 g (GLOBAL).
    expect(reg.findFactor('cup', 'gram', 'water')).toBeCloseTo(236.588, 3);
  });
});
