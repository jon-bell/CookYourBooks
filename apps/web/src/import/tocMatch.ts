import type { ImportTocEntry } from './model.js';

export interface TocSuggestion {
  entry: ImportTocEntry;
  score: number;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/**
 * Score a title against a TOC entry. Score is in [0,1]; higher is better.
 * - Exact normalized match: 1.0
 * - One contains the other: 0.85 ± length bias
 * - Otherwise: 1 - lev / max(len) (clamped to [0,1])
 */
export function scoreTocMatch(title: string, entryTitle: string): number {
  const a = normalize(title);
  const b = normalize(entryTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return 0.7 + 0.2 * ratio;
  }
  const dist = levenshtein(a, b);
  const score = 1 - dist / Math.max(a.length, b.length);
  return score < 0 ? 0 : score;
}

/**
 * Rank TOC entries by fuzzy match against the provided title. Returns
 * the top `limit` suggestions with `score >= minScore`. Order is
 * descending by score, then by page_number ascending as a tie break.
 */
export function suggestTocMatches(
  title: string,
  entries: readonly ImportTocEntry[],
  opts: { limit?: number; minScore?: number } = {},
): TocSuggestion[] {
  const limit = opts.limit ?? 6;
  const minScore = opts.minScore ?? 0.4;
  const scored: TocSuggestion[] = [];
  for (const entry of entries) {
    const score = scoreTocMatch(title, entry.title);
    if (score >= minScore) scored.push({ entry, score });
  }
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    const ap = x.entry.pageNumber ?? Number.MAX_SAFE_INTEGER;
    const bp = y.entry.pageNumber ?? Number.MAX_SAFE_INTEGER;
    return ap - bp;
  });
  return scored.slice(0, limit);
}
