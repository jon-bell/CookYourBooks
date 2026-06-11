import { describe, expect, it } from 'vitest';

import { normalizeIsbn } from './openLibrary.js';

describe('normalizeIsbn', () => {
  it('strips dashes and spaces from ISBN-13', () => {
    expect(normalizeIsbn('978-0-307-95216-9')).toBe('9780307952169');
    expect(normalizeIsbn(' 978 0 307 95216 9 ')).toBe('9780307952169');
  });

  it('accepts ISBN-10 with trailing X (uppercased)', () => {
    expect(normalizeIsbn('0-306-40615-x')).toBe('030640615X');
  });

  it('returns null for short / long inputs', () => {
    expect(normalizeIsbn('123')).toBeNull();
    expect(normalizeIsbn('12345678901234')).toBeNull();
  });

  it('returns null for non-digits in the middle', () => {
    expect(normalizeIsbn('97803079Z2169')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(normalizeIsbn('')).toBeNull();
  });
});
