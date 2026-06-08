// Pure formatting helpers for the LLM Cost Center. Kept framework-free so
// they're unit-testable in isolation.

/**
 * Format integer micro-USD as a dollar string. Sub-cent amounts (a single
 * cheap call can cost a fraction of a cent) get 4 decimals so they don't
 * collapse to "$0.00"; everything else uses normal 2-decimal currency.
 */
export function formatUsdFromMicros(micros: number): string {
  const dollars = (micros ?? 0) / 1_000_000;
  if (dollars > 0 && dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Whole-percent failure rate, guarding divide-by-zero. */
export function failureRatePct(failures: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((failures / total) * 100);
}

/** Thousands-separated token count. */
export function formatTokens(n: number): string {
  return (n ?? 0).toLocaleString();
}

/** Human label for a usage feature tag. */
export const FEATURE_LABEL: Record<string, string> = {
  ocr: 'OCR import',
  bakeoff: 'Model bake-off',
  rewrite: 'Step rewrite',
  isbn: 'ISBN scan',
  video: 'Link import',
  cover_image: 'Cover image',
};

export function featureLabel(feature: string): string {
  return FEATURE_LABEL[feature] ?? feature;
}
