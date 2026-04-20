export interface Servings {
  readonly amount: number;
  readonly description?: string;
}

export function servings(amount: number, description?: string): Servings {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid servings amount: ${amount}`);
  }
  return { amount, description };
}

/**
 * Render a servings block as "4 cookies" / "1 serving".
 *
 * Defaults to "serving"/"servings" when no description is set. If a
 * description is supplied, singularize/pluralize it based on amount using
 * a small set of irregulars common in recipe copy (otherwise fall back
 * to trailing-s).
 */
export function formatServings(s: Servings): string {
  const amount = formatAmount(s.amount);
  const desc = s.description?.trim() || (s.amount === 1 ? 'serving' : 'servings');
  const word = s.amount === 1 ? singular(desc) : plural(desc);
  return `${amount} ${word}`;
}

function formatAmount(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

// Recipe copy uses very few words with irregular plurals. Cover the ones
// that actually appear in the wild, then fall back to the naïve "s" rule.
const IRREGULAR_SINGULAR: Record<string, string> = {
  loaves: 'loaf',
  people: 'person',
  leaves: 'leaf',
  servings: 'serving',
  slices: 'slice',
  patties: 'patty',
};

const IRREGULAR_PLURAL: Record<string, string> = {
  loaf: 'loaves',
  person: 'people',
  leaf: 'leaves',
  serving: 'servings',
  slice: 'slices',
  patty: 'patties',
};

function singular(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR_SINGULAR[lower]) return matchCase(word, IRREGULAR_SINGULAR[lower]!);
  if (lower.endsWith('ies') && lower.length > 3) return matchCase(word, lower.slice(0, -3) + 'y');
  if (lower.endsWith('es') && !lower.endsWith('oes')) return matchCase(word, lower.slice(0, -2));
  if (lower.endsWith('s') && !lower.endsWith('ss')) return matchCase(word, lower.slice(0, -1));
  return word;
}

function plural(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR_PLURAL[lower]) return matchCase(word, IRREGULAR_PLURAL[lower]!);
  if (lower.endsWith('s') || lower.endsWith('x') || lower.endsWith('z')) return word;
  if (lower.endsWith('y') && !/[aeiou]y$/.test(lower))
    return matchCase(word, lower.slice(0, -1) + 'ies');
  return word + 's';
}

function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] && source[0] === source[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
