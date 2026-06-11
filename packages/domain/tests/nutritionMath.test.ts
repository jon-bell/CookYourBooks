import { describe, expect, it } from 'vitest';

import {
  fmtGrams,
  fmtKcal,
  fmtMg,
  ingredientLookupKey,
  type IngredientNutritionRow,
  type NutritionFact,
  quantityToGrams,
  scaleToServing,
  totalNutrition,
} from '../src/services/nutritionMath.js';

function fact(over: Partial<NutritionFact> = {}): NutritionFact {
  return {
    source: 'USDA_FDC',
    source_id: '1',
    description: 'test food',
    brand: null,
    calories_kcal: 100,
    protein_g: 2,
    fat_g: 1,
    saturated_fat_g: 0.5,
    carbs_g: 20,
    sugar_g: 5,
    fiber_g: 1,
    sodium_mg: 10,
    portions: [],
    ...over,
  };
}

describe('quantityToGrams', () => {
  it('prefers user override above all other sources', () => {
    const r = quantityToGrams(2, 'cup', 'flour', {
      override: { cup: 130 },
      densityRules: [{ fromUnit: 'cup', factor: 120, ingredientName: 'flour' }],
    });
    expect(r).toEqual({ grams: 260, approximate: false, source: 'override' });
  });

  it('matches ingredient-specific density before generic', () => {
    const r = quantityToGrams(1, 'cup', 'flour', {
      densityRules: [
        { fromUnit: 'cup', factor: 240, ingredientName: null },
        { fromUnit: 'cup', factor: 120, ingredientName: 'flour' },
      ],
    });
    expect(r?.grams).toBe(120);
    expect(r?.source).toBe('density');
  });

  it('falls back to nutrition-source portion data when no density rule matches', () => {
    const r = quantityToGrams(2, 'piece', 'egg', {
      portions: [{ unit: 'piece', grams: 50 }],
    });
    expect(r).toEqual({ grams: 100, approximate: false, source: 'portion' });
  });

  it('handles raw mass units without any ingredient context', () => {
    const r = quantityToGrams(8, 'oz', 'anything', {});
    expect(r?.grams).toBeCloseTo(226.8, 1);
    expect(r?.source).toBe('mass');
  });

  it('water-equivalent fallback for volume marks itself approximate', () => {
    const r = quantityToGrams(1, 'cup', 'mystery liquid', {});
    expect(r?.grams).toBeCloseTo(236.588, 2);
    expect(r?.approximate).toBe(true);
    expect(r?.source).toBe('water-equiv');
  });

  it('returns null for an unknown unit', () => {
    const r = quantityToGrams(1, 'pinch', 'salt', {});
    expect(r).toBeNull();
  });
});

describe('totalNutrition', () => {
  // Fixtures use only the columns each assertion touches so totals
  // stay attributable. The default `fact()` is mostly zero now —
  // overrides set the per-100g values that matter for the test.
  const rows: IngredientNutritionRow[] = [
    {
      ingredientId: 'a',
      ingredientName: 'flour',
      grams: 200,
      // 100 kcal/100g and 2 g protein/100g at 200 g → 200 kcal + 4 g protein.
      fact: fact({ calories_kcal: 100, protein_g: 2, fat_g: 0 }),
      approximate: false,
    },
    {
      ingredientId: 'b',
      ingredientName: 'butter',
      grams: 100,
      // 700 kcal/100g + 80 g fat/100g at 100 g → 700 kcal + 80 g fat.
      fact: fact({ calories_kcal: 700, fat_g: 80, protein_g: 0 }),
      approximate: false,
    },
  ];

  it('sums per-100g facts proportional to grams', () => {
    const t = totalNutrition(rows);
    expect(t.calories_kcal).toBeCloseTo(900, 4);
    expect(t.protein_g).toBeCloseTo(4, 4);
    expect(t.fat_g).toBeCloseTo(80, 4);
    expect(t.total_grams).toBe(300);
    expect(t.resolved_count).toBe(2);
    expect(t.unresolved_count).toBe(0);
  });

  it('skips unresolved rows but reports them in the counts', () => {
    const t = totalNutrition([
      ...rows,
      {
        ingredientId: 'c',
        ingredientName: 'salt to taste',
        grams: null,
        fact: null,
        approximate: false,
      },
    ]);
    expect(t.resolved_count).toBe(2);
    expect(t.unresolved_count).toBe(1);
    expect(t.calories_kcal).toBeCloseTo(900, 4);
  });

  it('flags approximate rows separately so the UI can disclaim', () => {
    const t = totalNutrition([
      {
        ...rows[0]!,
        approximate: true,
      },
      rows[1]!,
    ]);
    expect(t.approximate_count).toBe(1);
  });
});

describe('scaleToServing', () => {
  const totals = {
    calories_kcal: 800,
    protein_g: 20,
    fat_g: 40,
    saturated_fat_g: 10,
    carbs_g: 90,
    sugar_g: 5,
    fiber_g: 6,
    sodium_mg: 1200,
    total_grams: 1200,
    resolved_count: 5,
    unresolved_count: 0,
    approximate_count: 0,
  };

  it('proportion mode divides by the yield', () => {
    const s = scaleToServing(totals, { kind: 'proportion', servings: 4 });
    expect(s.calories_kcal).toBe(200);
    expect(s.protein_g).toBe(5);
    expect(s.total_grams).toBe(300);
    expect(s.ratio).toBe(0.25);
  });

  it('weight mode divides by the recipe-weight ratio', () => {
    // recipe is 1200 g, user ate 300 g → 1/4.
    const s = scaleToServing(totals, {
      kind: 'weight',
      totalRecipeGrams: 1200,
      servingGrams: 300,
    });
    expect(s.calories_kcal).toBe(200);
    expect(s.ratio).toBe(0.25);
  });

  it('non-positive denominators degrade to ratio=1 (UI surfaces the warning)', () => {
    expect(scaleToServing(totals, { kind: 'proportion', servings: 0 }).ratio).toBe(1);
    expect(
      scaleToServing(totals, { kind: 'weight', totalRecipeGrams: 0, servingGrams: 1 }).ratio,
    ).toBe(1);
  });
});

describe('formatters', () => {
  it('fmtGrams + fmtKcal + fmtMg quiet zero values', () => {
    expect(fmtGrams(0)).toBe('—');
    expect(fmtGrams(2.345)).toBe('2.3 g');
    expect(fmtKcal(0)).toBe('—');
    expect(fmtKcal(123.4)).toBe('123 kcal');
    expect(fmtMg(0)).toBe('—');
    expect(fmtMg(1199)).toBe('1199 mg');
  });
});

describe('ingredientLookupKey', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(ingredientLookupKey('  Wheat   Flour  ')).toBe('wheat flour');
    expect(ingredientLookupKey('BUTTER')).toBe('butter');
  });
});
