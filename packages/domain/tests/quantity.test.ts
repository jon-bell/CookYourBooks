import { describe, expect, it } from 'vitest';
import {
  exact,
  fractional,
  range,
  quantityToNumber,
  scaleQuantity,
  formatQuantity,
} from '../src/model/quantity.js';

describe('Quantity', () => {
  it('rejects invalid exact amounts', () => {
    expect(() => exact(-1, 'cup')).toThrow();
    expect(() => exact(Number.NaN, 'cup')).toThrow();
  });

  it('converts fractions to numbers', () => {
    expect(quantityToNumber(fractional(1, 1, 2, 'cup'))).toBe(1.5);
    expect(quantityToNumber(fractional(0, 3, 4, 'cup'))).toBe(0.75);
  });

  it('uses midpoint for range quantities', () => {
    expect(quantityToNumber(range(2, 4, 'cup'))).toBe(3);
  });

  it('rejects bad range bounds', () => {
    expect(() => range(4, 2, 'cup')).toThrow();
  });

  it('rejects bad fractions', () => {
    expect(() => fractional(0, 5, 3, 'cup')).toThrow();
    expect(() => fractional(0, 1, 0, 'cup')).toThrow();
  });

  it('scales exact quantities', () => {
    const scaled = scaleQuantity(exact(2, 'cup'), 1.5);
    expect(scaled).toEqual({ type: 'EXACT', amount: 3, unit: 'cup' });
  });

  it('scales fractions into exact amounts', () => {
    const scaled = scaleQuantity(fractional(1, 1, 2, 'cup'), 2);
    expect(scaled).toEqual({ type: 'EXACT', amount: 3, unit: 'cup' });
  });

  it('scales ranges', () => {
    expect(scaleQuantity(range(2, 4, 'cup'), 0.5)).toEqual({
      type: 'RANGE',
      min: 1,
      max: 2,
      unit: 'cup',
    });
  });

  it('formats quantities', () => {
    expect(formatQuantity(exact(2, 'cup'))).toBe('2 cup');
    expect(formatQuantity(fractional(1, 1, 2, 'cup'))).toBe('1 1/2 cup');
    expect(formatQuantity(fractional(0, 3, 4, 'cup'))).toBe('3/4 cup');
    expect(formatQuantity(range(2, 4, 'cup'))).toBe('2–4 cup');
  });
});
