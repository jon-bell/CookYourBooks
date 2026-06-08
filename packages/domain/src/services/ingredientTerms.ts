import { tokenizeIngredient } from './nutritionMath.js';

/**
 * Turn a messy recipe ingredient string into a clean set of search
 * terms for matching against the USDA / Open Food Facts food corpus.
 *
 * Why this exists: ingredient `name` strings carry a lot that confuses
 * a food-database search but doesn't change the food's nutritional
 * identity — preparation that leaked past the parser ("garlic cloves,
 * minced"), parentheticals ("parmesan cheese, grated (1 cup)"),
 * cook's-choice alternative lists ("peanut, rice bran, or other neutral
 * oil"), size adjectives ("small red onion"), and counting/container
 * nouns ("garlic cloves", "2 sprigs thyme"). Left in, these either
 * over-constrain a strict-AND query (zero hits) or pull in the wrong
 * row (the nut instead of the oil).
 *
 * What we keep: the food nouns plus *nutrition-relevant* modifiers
 * (whole vs skim, full-fat vs low-fat, raw vs cooked, all-purpose vs
 * whole-wheat). Those genuinely change the per-100g facts, so they must
 * survive into the query — see NUTRITION_MODIFIERS, which overrides the
 * drop lists.
 *
 * This is the single source of truth for search normalization. It runs
 * in three places that must agree: the browser local-essentials search
 * (apps/web/src/nutrition/localCache.ts), the recipe-nutrition hook, and
 * — via a byte-for-byte port — the `nutrition` Edge Function
 * (supabase/functions/nutrition/_ingredientTerms.ts). When you change
 * the algorithm or the word lists here, mirror them there; the test
 * table in ingredientTerms.test.ts is the contract both copies satisfy.
 */

export interface IngredientTerms {
  /** Cleaned tokens joined by a single space. Fed to the SQL RPC as
   *  `p_query` (Postgres re-tokenizes it). Empty string if nothing
   *  survives. */
  normalized: string;
  /** Ordered, de-duplicated search tokens after noise removal. Used for
   *  the relaxed OR retrieval + coverage scoring on both sides. */
  terms: string[];
  /** The likely head food noun(s) — the most distinctive token, used to
   *  decide whether a lexical hit is "good enough" or the caller should
   *  fall back to semantic search. */
  core: string[];
  /** Nutrition-relevant refiners present in the string (whole / skim /
   *  raw / all-purpose …). Informational; ranking uses `terms`. */
  modifiers: string[];
}

// Preparation verbs/adverbs. A comma-segment made up entirely of these
// (plus other noise) is dropped wholesale ("garlic cloves, minced" →
// keep "garlic cloves", drop "minced"); individually they're also
// stripped anywhere they appear.
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

// Size / quantity / counting / container words. Dropped — they describe
// amount or packaging, not the food.
const SIZE_QTY_WORDS = new Set([
  'small', 'large', 'medium', 'big', 'thin', 'thick', 'mini', 'jumbo',
  'baby', 'long', 'short', 'whole', // NOTE "whole" is also a nutrition
  // modifier (whole milk); NUTRITION_MODIFIERS below re-rescues it.
  'clove', 'cloves', 'sprig', 'sprigs', 'stalk', 'stalks', 'head', 'heads',
  'bunch', 'bunches', 'can', 'cans', 'package', 'packages', 'pkg',
  'slice', 'slices', 'piece', 'pieces', 'strip', 'strips', 'pinch',
  'handful', 'jar', 'jars', 'bottle', 'box', 'bag',
]);

// Generic English stopwords plus recipe filler. Dropped.
const STOP_WORDS = new Set([
  'of', 'the', 'a', 'an', 'and', 'or', 'with', 'to', 'taste', 'your',
  'favorite', 'good', 'quality', 'such', 'as', 'some', 'any', 'other',
  // NB "plain" is deliberately NOT here — auto-match is generic-only so
  // there's no branded "PLAIN OATGURT" spam to dodge, and keeping it
  // lets "plain yogurt" outrank the flavored generic variants.
]);

// Words that DO change the nutritional identity and must survive even if
// they appear in the drop lists above. This is the highest-leverage
// list — under-including it loses real signal, over-including it lets
// noise back in. Grounded in the production ingredient corpus.
const NUTRITION_MODIFIERS = new Set([
  'whole', 'skim', 'nonfat', 'fat', 'full', 'low', 'reduced', 'fatfree',
  'raw', 'cooked', 'dried', 'fresh', 'ground', 'toasted', 'roasted',
  'unsalted', 'salted', 'sweetened', 'unsweetened', 'light', 'dark',
  'brown', 'granulated', 'powdered', 'heavy', 'lean', 'boneless',
  'skinless', 'bone', 'wheat', 'purpose', 'rising', 'extra', 'virgin',
]);

const DIGITS = /^\d+$/;

/** True if a token carries no food meaning on its own. */
function isNoise(tok: string): boolean {
  if (NUTRITION_MODIFIERS.has(tok)) return false;
  if (tok.length <= 1) return true;
  if (DIGITS.test(tok)) return true;
  return PREP_WORDS.has(tok) || SIZE_QTY_WORDS.has(tok) || STOP_WORDS.has(tok);
}

export function extractIngredientTerms(raw: string): IngredientTerms {
  const lower = (raw ?? '')
    .toLowerCase()
    // Drop parentheticals: "(chopped)", "(1 cup)".
    .replace(/\([^)]*\)/g, ' ')
    // "A, B, or other C": C is the category/head noun ("… or other
    // neutral oil" → "neutral oil"); the listed examples before it are
    // filler. Drop everything up to and including "or other".
    .replace(/.*\bor\s+other\s+/, '')
    // Plain alternatives "X or Y" (no "other"): keep the first concrete
    // option ("light soy sauce or shoyu" → "light soy sauce").
    .replace(/\s+or\b.*$/, ' ');

  // Split on commas into segments, then keep only segments that contain
  // at least one real food token. "garlic cloves, minced" → seg "minced"
  // is all-noise and gets dropped; "bone-in chicken breasts, trimmed" →
  // "trimmed" dropped. This replaces the old "strip everything after the
  // first comma", which nuked multi-noun names and produced zero hits.
  const segments = lower.split(',');
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    const toks = tokenizeIngredient(seg);
    if (toks.length === 0) continue;
    // Drop a segment that is pure preparation/noise (no food noun).
    if (toks.every((t) => isNoise(t))) continue;
    for (const t of toks) {
      if (isNoise(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      terms.push(t);
    }
  }

  // Safety net: if every token was classified as noise (e.g. the whole
  // string was "to taste"), fall back to the raw food-ish tokens so we
  // never search for nothing.
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
  // Food names are head-final in English ("olive oil", "red onion",
  // "soy sauce"), so the last surviving food noun is the best single
  // discriminator. Fall back to the last term if all are modifiers.
  const head = foodNouns.length > 0 ? foodNouns[foodNouns.length - 1] : terms[terms.length - 1];
  const core = head ? [head] : [];

  return { normalized: terms.join(' '), terms, core, modifiers };
}

/** Convenience: the space-joined cleaned query for the SQL RPC. */
export function ingredientSearchQuery(raw: string): string {
  return extractIngredientTerms(raw).normalized;
}
