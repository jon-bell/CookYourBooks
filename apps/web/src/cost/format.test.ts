import { describe, expect, it } from 'vitest';

import { failureRatePct, featureLabel, formatTokens, formatUsdFromMicros } from './format.js';

describe('formatUsdFromMicros', () => {
  it('formats whole dollars and cents to 2 decimals', () => {
    expect(formatUsdFromMicros(8_000_000)).toBe('$8.00');
    expect(formatUsdFromMicros(1_234_500)).toBe('$1.23');
  });

  it('uses 4 decimals for sub-cent amounts so a cheap call is not $0.00', () => {
    expect(formatUsdFromMicros(9234)).toBe('$0.0092');
    expect(formatUsdFromMicros(42)).toBe('$0.0000'); // tiny but non-zero
  });

  it('shows exactly $0.00 for zero and handles nullish', () => {
    expect(formatUsdFromMicros(0)).toBe('$0.00');
    expect(formatUsdFromMicros(undefined as unknown as number)).toBe('$0.00');
  });
});

describe('failureRatePct', () => {
  it('computes whole-percent rate', () => {
    expect(failureRatePct(1, 4)).toBe(25);
    expect(failureRatePct(0, 10)).toBe(0);
  });

  it('guards divide-by-zero', () => {
    expect(failureRatePct(0, 0)).toBe(0);
    expect(failureRatePct(3, 0)).toBe(0);
  });
});

describe('formatTokens', () => {
  it('thousands-separates', () => {
    expect(formatTokens(1234567)).toBe((1234567).toLocaleString());
    expect(formatTokens(0)).toBe('0');
  });
});

describe('featureLabel', () => {
  it('maps known features and passes through unknowns', () => {
    expect(featureLabel('ocr')).toBe('OCR import');
    expect(featureLabel('isbn')).toBe('ISBN scan');
    expect(featureLabel('video')).toBe('Link import');
    expect(featureLabel('mystery')).toBe('mystery');
  });
});
