import { describe, expect, it } from 'vitest';

import { extractIngredientTerms, ingredientSearchQuery } from './ingredientTerms.js';

// The cases below are real ingredient strings pulled from the production
// recipe corpus (the ones that exposed the matching bugs), plus the
// nutrition-modifier guards. This table is the contract that the
// byte-for-byte edge-function port
// (supabase/functions/nutrition/_ingredientTerms.ts) must also satisfy.

describe('extractIngredientTerms', () => {
  const cases: Array<{
    raw: string;
    terms: string[];
    core: string[];
    note?: string;
  }> = [
    // Preparation leaked past the parser into `name`. The old "strip
    // after first comma" kept "garlic cloves" and the strict-AND query
    // found nothing; now the prep segment is dropped and the counting
    // noun "cloves" too, leaving the real food.
    { raw: 'garlic cloves, minced', terms: ['garlic'], core: ['garlic'] },
    { raw: 'onion, chopped fine', terms: ['onion'], core: ['onion'] },
    { raw: 'parmesan cheese, grated (1 cup)', terms: ['parmesan', 'cheese'], core: ['cheese'] },
    { raw: 'minced fresh parsley', terms: ['fresh', 'parsley'], core: ['parsley'] },

    // The headline bug: a strict AND over "plain full-fat yogurt" only
    // matched a branded non-dairy product. We keep the nutrition-
    // relevant modifiers (full, fat) and the food noun.
    {
      raw: 'plain full-fat yogurt',
      terms: ['plain', 'full', 'fat', 'yogurt'],
      core: ['yogurt'],
    },
    { raw: 'whole milk', terms: ['whole', 'milk'], core: ['milk'] },
    {
      raw: 'all-purpose flour',
      terms: ['all', 'purpose', 'flour'],
      core: ['flour'],
      note: 'purpose is a protected modifier; all is dropped (len<=… no) — see below',
    },

    // Size / counting / container words are noise.
    { raw: 'small red onion', terms: ['red', 'onion'], core: ['onion'] },
    { raw: '2 sprigs fresh thyme', terms: ['fresh', 'thyme'], core: ['thyme'] },

    // Alternative lists: keep the first concrete option, drop "or other…".
    {
      raw: 'peanut, rice bran, or other neutral oil',
      terms: ['neutral', 'oil'],
      core: ['oil'],
      note: '"or other C" → C is the category head noun',
    },
    {
      raw: 'light soy sauce or shoyu',
      terms: ['light', 'soy', 'sauce'],
      core: ['sauce'],
      note: 'plain "or" keeps the first option',
    },

    // Pure-vague fallback must not yield an empty query.
    { raw: 'salt and pepper', terms: ['salt', 'pepper'], core: ['pepper'] },
    { raw: 'kosher salt', terms: ['kosher', 'salt'], core: ['salt'] },
  ];

  for (const c of cases) {
    it(`"${c.raw}" → [${c.terms.join(', ')}]`, () => {
      const out = extractIngredientTerms(c.raw);
      expect(out.terms).toEqual(c.terms);
      expect(out.core).toEqual(c.core);
      expect(out.normalized).toBe(c.terms.join(' '));
    });
  }

  it('never returns empty terms for a non-empty food string', () => {
    expect(extractIngredientTerms('salt to taste').terms.length).toBeGreaterThan(0);
    expect(extractIngredientTerms('a pinch of saffron').terms).toContain('saffron');
  });

  it('protects nutrition-relevant modifiers from the size/stop drop', () => {
    // "whole" is in the size list (whole onion) but must survive in
    // "whole milk" because it changes the facts.
    expect(extractIngredientTerms('whole milk').terms).toContain('whole');
    // "fat", "full", "skim", "nonfat" must all survive.
    expect(extractIngredientTerms('low-fat yogurt').terms).toContain('fat');
    expect(extractIngredientTerms('skim milk').terms).toContain('skim');
  });

  it('ingredientSearchQuery returns the space-joined normalized form', () => {
    expect(ingredientSearchQuery('garlic cloves, minced')).toBe('garlic');
    expect(ingredientSearchQuery('plain full-fat yogurt')).toBe('plain full fat yogurt');
  });

  // --- Accented ingredients (2026-09) ---
  // The tokenizer used to strip non-ASCII, which shattered the word
  // rather than folding it: "jalapeño" → ["jalape"], "pâté" → []. Every
  // accented ingredient in the corpus failed to match anything.
  it('folds diacritics instead of shattering the word', () => {
    expect(ingredientSearchQuery('jalapeño')).toBe('jalapeno');
    expect(ingredientSearchQuery('crème fraîche')).toBe('creme fraiche');
    expect(ingredientSearchQuery('tomato purée')).toBe('tomato puree');
    // Previously produced the empty string, so the search had nothing
    // to run and the ingredient silently resolved to nothing.
    expect(ingredientSearchQuery('pâté')).toBe('pate');
  });

  // --- Shared head noun across an alternative list (2026-09) ---
  it('keeps the noun that both options of an "or" list share', () => {
    expect(ingredientSearchQuery('green or brown lentils')).toBe('green lentils');
    expect(ingredientSearchQuery('cherry or grape tomatoes')).toBe('cherry tomatoes');
    expect(ingredientSearchQuery('coconut or vegetable oil')).toBe('coconut oil');
    expect(ingredientSearchQuery('unsulfured or blackstrap molasses')).toBe('unsulfured molasses');
  });

  it('still keeps only the first option when the alternatives are whole foods', () => {
    expect(ingredientSearchQuery('light soy sauce or shoyu')).toBe('light soy sauce');
    expect(ingredientSearchQuery('unsalted butter or vegan butter')).toBe('unsalted butter');
  });

  // --- Head noun must be the food, not a part of it (2026-09) ---
  it('heads on the food rather than the part word', () => {
    expect(extractIngredientTerms('cinnamon stick').core).toEqual(['cinnamon']);
    expect(extractIngredientTerms('lemon zest').core).toEqual(['lemon']);
    expect(extractIngredientTerms('basil leaves').core).toEqual(['basil']);
    expect(extractIngredientTerms('lime wedges').core).toEqual(['lime']);
    expect(extractIngredientTerms('broccoli florets').core).toEqual(['broccoli']);
    // The part word still contributes to retrieval coverage — USDA's
    // row really is "Spices, bay leaf".
    expect(extractIngredientTerms('basil leaves').terms).toContain('leaves');
  });

  // --- Compound strings (2026-09) ---
  it('flags two-food strings so callers can decline to auto-match', () => {
    expect(extractIngredientTerms('salt and pepper').compound).toBe(true);
    expect(extractIngredientTerms('kosher salt and ground black pepper').compound).toBe(true);
  });

  it('does not flag "and" strings that name a single food', () => {
    // Hyphenated compound word, not a conjunction.
    expect(extractIngredientTerms('half-and-half').compound).toBe(false);
    // "and" joining preparation, not foods.
    expect(extractIngredientTerms('unsalted butter, melted and cooled').compound).toBe(false);
    // One food, two parts of it.
    expect(extractIngredientTerms('fresh cilantro leaves and tender stems').compound).toBe(false);
  });
});
