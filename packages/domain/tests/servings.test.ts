import { describe, expect, it } from 'vitest';
import { formatServings, servings } from '../src/model/servings.js';

describe('formatServings', () => {
  it('defaults to "serving"/"servings"', () => {
    expect(formatServings(servings(1))).toBe('1 serving');
    expect(formatServings(servings(4))).toBe('4 servings');
  });

  it('regular pluralization', () => {
    expect(formatServings(servings(1, 'cookie'))).toBe('1 cookie');
    expect(formatServings(servings(24, 'cookie'))).toBe('24 cookies');
    expect(formatServings(servings(12, 'muffin'))).toBe('12 muffins');
  });

  it('-y words', () => {
    expect(formatServings(servings(1, 'patty'))).toBe('1 patty');
    expect(formatServings(servings(6, 'patty'))).toBe('6 patties');
  });

  it('irregular plurals', () => {
    expect(formatServings(servings(1, 'loaf'))).toBe('1 loaf');
    expect(formatServings(servings(2, 'loaf'))).toBe('2 loaves');
  });

  it('already-plural descriptions get singularized at 1', () => {
    // Users sometimes type the plural form into the description field.
    // "servings" -> "serving" at 1, stays "servings" at anything else.
    expect(formatServings(servings(1, 'servings'))).toBe('1 serving');
    expect(formatServings(servings(6, 'loaves'))).toBe('6 loaves');
  });

  it('preserves leading case', () => {
    expect(formatServings(servings(2, 'Cookie'))).toBe('2 Cookies');
  });
});
