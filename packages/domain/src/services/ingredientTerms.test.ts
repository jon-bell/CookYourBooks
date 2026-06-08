import { describe, it, expect } from 'vitest';
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
});
