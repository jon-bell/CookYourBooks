import { describe, expect, it } from 'vitest';
import { parseIngredientLine } from '../src/services/parseIngredient.js';
describe('parseIngredientLine', () => {
    it('parses simple measured ingredients', () => {
        const out = parseIngredientLine('2 cups flour');
        expect(out?.type).toBe('MEASURED');
        if (out?.type === 'MEASURED') {
            expect(out.name).toBe('flour');
            expect(out.quantity).toEqual({ type: 'EXACT', amount: 2, unit: 'cup' });
        }
    });
    it('parses mixed numbers', () => {
        const out = parseIngredientLine('1 1/2 tsp salt');
        if (out?.type === 'MEASURED') {
            expect(out.quantity).toEqual({
                type: 'FRACTIONAL',
                whole: 1,
                numerator: 1,
                denominator: 2,
                unit: 'teaspoon',
            });
        }
        else {
            throw new Error('expected measured');
        }
    });
    it('splits name and preparation on comma', () => {
        const out = parseIngredientLine('3 cloves garlic, minced');
        if (out?.type === 'MEASURED') {
            expect(out.name).toBe('garlic');
            expect(out.preparation).toBe('minced');
        }
        else {
            throw new Error('expected measured');
        }
    });
    it('returns vague ingredient for "to taste"', () => {
        const out = parseIngredientLine('salt to taste');
        expect(out?.type).toBe('VAGUE');
        expect(out?.name).toBe('salt');
    });
    it('returns vague ingredient when no unit recognized', () => {
        const out = parseIngredientLine('just some olive oil');
        expect(out?.type).toBe('VAGUE');
    });
    it('strips leading list markers', () => {
        const out = parseIngredientLine('- 2 cups flour');
        expect(out?.type).toBe('MEASURED');
    });
    it('returns undefined on empty input', () => {
        expect(parseIngredientLine('')).toBeUndefined();
        expect(parseIngredientLine('   ')).toBeUndefined();
    });
});
//# sourceMappingURL=parseIngredient.test.js.map