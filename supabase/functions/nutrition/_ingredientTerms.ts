// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerate with:  node scripts/sync-ingredient-terms.mjs
// Source of truth:  packages/domain/src/services/ingredientTerms.ts
//                   (+ tokenizeIngredient, inlined from packages/domain/src/services/nutritionMath.ts)
//
// The edge function bundles only its own directory, so it cannot import
// the domain package and needs this physical copy. The contract both
// copies satisfy lives in packages/domain/src/services/ingredientTerms.test.ts.

/**
 * Tokenize an ingredient name for substring matching against density
 * rules. Hyphens, commas, and punctuation collapse to whitespace so
 * "all-purpose flour, sifted" and "All Purpose Flour" tokenize the
 * same way: ["all", "purpose", "flour"] (+ "sifted" in the first).
 *
 * Used in both quantityToGrams (rule selection) and the UI filter
 * that pre-narrows the rule set per ingredient — keeping the logic in
 * one place means both sides agree on whether a rule "applies".
 */
function tokenizeIngredient(name: string): string[] {
  return name
    .toLowerCase()
    // Decompose accented characters and drop the combining marks, so
    // "jalapeño" tokenizes as "jalapeno" rather than shattering into
    // ["jalape"] when the ASCII strip below eats the ñ. Without this,
    // "crème fraîche" became ["cr","me","fra","che"] and "pâté" became
    // [] entirely — every accented ingredient failed to match.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}


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
  /** True when the string names two distinct foods ("salt and pepper").
   *  A single match cannot represent both, so callers should decline to
   *  auto-match rather than confidently picking one of them. */
  compound: boolean;
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
  'minced',
  'chopped',
  'diced',
  'grated',
  'shredded',
  'sliced',
  'sifted',
  'melted',
  'softened',
  'drained',
  'rinsed',
  'beaten',
  'peeled',
  'trimmed',
  'halved',
  'quartered',
  'crushed',
  'seeded',
  'cored',
  'cubed',
  'mashed',
  'crumbled',
  'cracked',
  'separated',
  'divided',
  'packed',
  'rolled',
  'cut',
  'into',
  'inch',
  'inches',
  'cm',
  'removed',
  'discarded',
  'reserved',
  'finely',
  'coarsely',
  'roughly',
  'thinly',
  'freshly',
  'lightly',
  'well',
  'fine',
  'coarse',
  'room',
  'temperature',
  'softened',
  'plus',
  'more',
  'for',
  'serving',
  'garnish',
  'optional',
  'preferably',
  'about',
  'approx',
  'approximately',
  // Preparation that appears after "and" ("melted and cooled") or as a
  // trailing participle. Without these the word survives noise removal
  // and reads as a food noun.
  'cooled',
  'warmed',
  'chilled',
  'thawed',
  'stemmed',
  'pitted',
  'squeezed',
  'deveined',
  'julienned',
  'shaved',
  'torn',
  'picked',
  'rested',
  'strained',
]);

// Size / quantity / counting / container words. Dropped — they describe
// amount or packaging, not the food.
const SIZE_QTY_WORDS = new Set([
  'small',
  'large',
  'medium',
  'big',
  'thin',
  'thick',
  'mini',
  'jumbo',
  'baby',
  'long',
  'short',
  'whole', // NOTE "whole" is also a nutrition
  // modifier (whole milk); NUTRITION_MODIFIERS below re-rescues it.
  'clove',
  'cloves',
  'sprig',
  'sprigs',
  'stalk',
  'stalks',
  'head',
  'heads',
  'bunch',
  'bunches',
  'can',
  'cans',
  'package',
  'packages',
  'pkg',
  'slice',
  'slices',
  'piece',
  'pieces',
  'strip',
  'strips',
  'pinch',
  'handful',
  'jar',
  'jars',
  'bottle',
  'box',
  'bag',
]);

// Generic English stopwords plus recipe filler. Dropped.
const STOP_WORDS = new Set([
  'of',
  'the',
  'a',
  'an',
  'and',
  'or',
  'with',
  'to',
  'taste',
  'your',
  'favorite',
  'good',
  'quality',
  'such',
  'as',
  'some',
  'any',
  'other',
  // NB "plain" is deliberately NOT here — auto-match is generic-only so
  // there's no branded "PLAIN OATGURT" spam to dodge, and keeping it
  // lets "plain yogurt" outrank the flavored generic variants.
]);

// Words that DO change the nutritional identity and must survive even if
// they appear in the drop lists above. This is the highest-leverage
// list — under-including it loses real signal, over-including it lets
// noise back in. Grounded in the production ingredient corpus.
const NUTRITION_MODIFIERS = new Set([
  'whole',
  'skim',
  'nonfat',
  'fat',
  'full',
  'low',
  'reduced',
  'fatfree',
  'raw',
  'cooked',
  'dried',
  'fresh',
  'ground',
  'toasted',
  'roasted',
  'unsalted',
  'salted',
  'sweetened',
  'unsweetened',
  'light',
  'dark',
  'brown',
  'granulated',
  'powdered',
  'heavy',
  'lean',
  'boneless',
  'skinless',
  'bone',
  'wheat',
  'purpose',
  'rising',
  'extra',
  'virgin',
]);

// Parts of a plant / preparation forms that are NOT the food itself.
// They stay in `terms` (they help coverage — "Spices, bay leaf" really
// does contain "leaf"), but they must never be chosen as the head noun:
// the head is what decides whether a lexical hit is on-topic, and
// "cinnamon stick" is a cinnamon question, not a stick question.
const PART_WORDS = new Set([
  'stick',
  'sticks',
  'zest',
  'zested',
  'peel',
  'rind',
  'leaf',
  'leaves',
  'stem',
  'stems',
  'stalk',
  'stalks',
  'sprig',
  'sprigs',
  'wedge',
  'wedges',
  'kernel',
  'kernels',
  'floret',
  'florets',
  'root',
  'roots',
  'bulb',
  'seeds',
  'pods',
  'halves',
  // Preparation FORMS. Same reasoning: "tomato paste" is a tomato
  // question, "red pepper flakes" a pepper question, "baking powder" a
  // baking question. Leaving these as the head sent them to "Guava
  // paste", "Cereal, wheat flakes" and "Baobab powder" respectively.
  // They stay in `terms`, so the right row still scores for containing
  // them.
  'paste',
  'powder',
  'flakes',
  'extract',
  'puree',
  'syrup',
]);

const DIGITS = /^\d+$/;

/** True if a token carries no food meaning on its own. */
function isNoise(tok: string): boolean {
  if (NUTRITION_MODIFIERS.has(tok)) return false;
  if (tok.length <= 1) return true;
  if (DIGITS.test(tok)) return true;
  return PREP_WORDS.has(tok) || SIZE_QTY_WORDS.has(tok) || STOP_WORDS.has(tok);
}

/**
 * Resolve a plain "X or Y" alternative list.
 *
 * The old rule was "keep everything before `or`", which is right when
 * the alternatives are whole foods ("light soy sauce or shoyu" →
 * "light soy sauce") but destroys the far more common shape where the
 * options share a trailing head noun:
 *
 *   "green or brown lentils"   -> "green"   (the lentils vanished)
 *   "cherry or grape tomatoes" -> "cherry"
 *   "coconut or vegetable oil" -> "coconut"
 *
 * Those all matched an unrelated food. When the right-hand side has
 * more tokens than the left, the surplus is the shared noun, so splice
 * it back onto the first option.
 */
function resolveAlternatives(text: string): string {
  const m = /^(.*?)\s+or\s+(.*)$/.exec(text);
  if (!m) return text;
  const left = (m[1] ?? '').trim();
  const right = (m[2] ?? '').trim();
  if (!left || !right) return text.replace(/\s+or\b.*$/, ' ');
  const lt = left.split(/\s+/).filter(Boolean);
  const rt = right.split(/\s+/).filter(Boolean);
  // Right side no longer than the left: the options are independent
  // foods, keep the first one (the historical behaviour).
  if (rt.length <= lt.length) return left;
  // Surplus tokens on the right are the noun both options modify.
  return [...lt, ...rt.slice(lt.length)].join(' ');
}

/**
 * True when the string names two genuinely different foods joined by
 * "and" — "salt and pepper", "kosher salt and ground black pepper".
 * One nutrition row cannot stand in for both, and picking either is
 * confidently wrong, so the caller declines to auto-match.
 *
 * Deliberately conservative, because most "and" strings are NOT
 * compounds and a false positive silently drops a resolvable
 * ingredient:
 *   "half-and-half"                      — one food, hyphenated
 *   "unsalted butter, melted and cooled" — "and" joins preparation
 *   "cilantro leaves and tender stems"   — one food, two parts
 * So we require a real food noun on both sides, and treat part-words
 * and prep as disqualifying.
 */
function isCompound(text: string): boolean {
  // Hyphenated "-and-" is a compound word, not a conjunction.
  if (/-and-/.test(text)) return false;
  // Only the first comma segment names the food; everything after it is
  // preparation, and prep is full of harmless "and"s — "chicken thighs,
  // boneless and skinless", "ginger, peeled and sliced", "asparagus,
  // trimmed and cut into 1-inch lengths" are each ONE ingredient.
  const foodSegment = text.split(',')[0] ?? '';
  const parts = foodSegment.split(/\s+and\s+/);
  if (parts.length !== 2) return false;
  const [lhs, rhs] = parts as [string, string];
  const headOf = (part: string): string | null => {
    const toks = tokenizeIngredient(part).filter((t) => !isNoise(t));
    if (toks.length === 0) return null;
    // A clause that ENDS in a part word is describing a part of the
    // other side's food, not a second food: "cilantro leaves and tender
    // stems" is one herb. Requiring the clause to end in a real noun is
    // what separates that from "salt and pepper".
    if (PART_WORDS.has(toks[toks.length - 1] ?? '')) return null;
    const nouns = toks.filter((t) => !NUTRITION_MODIFIERS.has(t) && !PART_WORDS.has(t));
    return nouns.length > 0 ? (nouns[nouns.length - 1] ?? null) : null;
  };
  const a = headOf(lhs);
  const b = headOf(rhs);
  if (a === null || b === null || a === b) return false;
  // "beet and rosemary syrup" / "burnt garlic sesame and chile oil" are
  // ONE food whose name happens to contain "and": both sides modify a
  // trailing noun, exactly like the "or" lists above. A genuine compound
  // is balanced — "salt and pepper", "butter and oil" — so compare the
  // count of real nouns, not tokens ("kosher salt and ground black
  // pepper" is balanced once modifiers are discounted).
  const nounCount = (part: string): number =>
    tokenizeIngredient(part)
      .filter((t) => !isNoise(t))
      .filter((t) => !NUTRITION_MODIFIERS.has(t) && !PART_WORDS.has(t)).length;
  return nounCount(rhs) <= nounCount(lhs);
}

export function extractIngredientTerms(raw: string): IngredientTerms {
  const original = (raw ?? '').toLowerCase();
  const lower = resolveAlternatives(
    original
      // Drop parentheticals: "(chopped)", "(1 cup)".
      .replace(/\([^)]*\)/g, ' ')
      // "A, B, or other C": C is the category/head noun ("… or other
      // neutral oil" → "neutral oil"); the listed examples before it are
      // filler. Drop everything up to and including "or other".
      .replace(/.*\bor\s+other\s+/, ''),
  );

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
  // discriminator. Prefer a noun that names an actual food over one that
  // names a part of it, so "cinnamon stick" heads on "cinnamon" and
  // "lemon zest" on "lemon". Fall back through part-words, then
  // modifiers, so we always emit something.
  const realNouns = foodNouns.filter((t) => !PART_WORDS.has(t));
  const pool = realNouns.length > 0 ? realNouns : foodNouns;
  const head = pool.length > 0 ? pool[pool.length - 1] : terms[terms.length - 1];
  const core = head ? [head] : [];

  return {
    normalized: terms.join(' '),
    terms,
    core,
    modifiers,
    compound: isCompound(original.replace(/\([^)]*\)/g, ' ')),
  };
}

/** Convenience: the space-joined cleaned query for the SQL RPC. */
export function ingredientSearchQuery(raw: string): string {
  return extractIngredientTerms(raw).normalized;
}
