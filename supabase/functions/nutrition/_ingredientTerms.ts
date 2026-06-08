// Port of packages/domain/src/services/ingredientTerms.ts (plus the
// tiny `tokenizeIngredient` it depends on from nutritionMath.ts).
// Behaviour is bit-exact with the domain copy. When you change the
// algorithm or the word lists here, change them there too — and vice
// versa. The contract both copies satisfy lives in
// packages/domain/src/services/ingredientTerms.test.ts.
//
// See the domain copy for the full rationale. Short version: messy
// recipe ingredient strings carry preparation, parentheticals, cook's-
// choice alternative lists, size adjectives and counting nouns that
// confuse a food-DB search without changing the food's identity. We
// strip those and keep the food nouns + nutrition-relevant modifiers.

export interface IngredientTerms {
  normalized: string;
  terms: string[];
  core: string[];
  modifiers: string[];
}

// Inlined from nutritionMath.tokenizeIngredient — keep in sync.
function tokenizeIngredient(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const PREP_WORDS = new Set([
  'minced', 'chopped', 'diced', 'grated', 'shredded', 'sliced', 'sifted',
  'melted', 'softened', 'drained', 'rinsed', 'beaten', 'peeled', 'trimmed',
  'halved', 'quartered', 'crushed', 'seeded', 'cored', 'cubed', 'mashed',
  'crumbled', 'cracked', 'separated', 'divided', 'packed', 'rolled',
  'cut', 'into', 'inch', 'inches', 'cm', 'removed', 'discarded', 'reserved',
  'finely', 'coarsely', 'roughly', 'thinly', 'freshly', 'lightly', 'well',
  'fine', 'coarse',
  'room', 'temperature', 'softened', 'plus', 'more', 'for', 'serving',
  'garnish', 'optional', 'preferably', 'about', 'approx', 'approximately',
]);

const SIZE_QTY_WORDS = new Set([
  'small', 'large', 'medium', 'big', 'thin', 'thick', 'mini', 'jumbo',
  'baby', 'long', 'short', 'whole',
  'clove', 'cloves', 'sprig', 'sprigs', 'stalk', 'stalks', 'head', 'heads',
  'bunch', 'bunches', 'can', 'cans', 'package', 'packages', 'pkg',
  'slice', 'slices', 'piece', 'pieces', 'strip', 'strips', 'pinch',
  'handful', 'jar', 'jars', 'bottle', 'box', 'bag',
]);

const STOP_WORDS = new Set([
  'of', 'the', 'a', 'an', 'and', 'or', 'with', 'to', 'taste', 'your',
  'favorite', 'good', 'quality', 'such', 'as', 'some', 'any', 'other',
]);

const NUTRITION_MODIFIERS = new Set([
  'whole', 'skim', 'nonfat', 'fat', 'full', 'low', 'reduced', 'fatfree',
  'raw', 'cooked', 'dried', 'fresh', 'ground', 'toasted', 'roasted',
  'unsalted', 'salted', 'sweetened', 'unsweetened', 'light', 'dark',
  'brown', 'granulated', 'powdered', 'heavy', 'lean', 'boneless',
  'skinless', 'bone', 'wheat', 'purpose', 'rising', 'extra', 'virgin',
]);

const DIGITS = /^\d+$/;

function isNoise(tok: string): boolean {
  if (NUTRITION_MODIFIERS.has(tok)) return false;
  if (tok.length <= 1) return true;
  if (DIGITS.test(tok)) return true;
  return PREP_WORDS.has(tok) || SIZE_QTY_WORDS.has(tok) || STOP_WORDS.has(tok);
}

export function extractIngredientTerms(raw: string): IngredientTerms {
  const lower = (raw ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/.*\bor\s+other\s+/, '')
    .replace(/\s+or\b.*$/, ' ');

  const segments = lower.split(',');
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    const toks = tokenizeIngredient(seg);
    if (toks.length === 0) continue;
    if (toks.every((t) => isNoise(t))) continue;
    for (const t of toks) {
      if (isNoise(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      terms.push(t);
    }
  }

  if (terms.length === 0) {
    for (const t of tokenizeIngredient(lower)) {
      if (DIGITS.test(t) || t.length <= 1) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      terms.push(t);
    }
  }

  const modifiers = terms.filter((t) => NUTRITION_MODIFIERS.has(t));
  const foodNouns = terms.filter((t) => !NUTRITION_MODIFIERS.has(t));
  const head = foodNouns.length > 0 ? foodNouns[foodNouns.length - 1] : terms[terms.length - 1];
  const core = head ? [head] : [];

  return { normalized: terms.join(' '), terms, core, modifiers };
}

export function ingredientSearchQuery(raw: string): string {
  return extractIngredientTerms(raw).normalized;
}
