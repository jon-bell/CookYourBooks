#!/usr/bin/env node
// Regenerate supabase/functions/nutrition/_ingredientTerms.ts from the
// domain copy, so the two can't drift.
//
// The edge function bundles only its own directory, so it can't import
// packages/domain — it needs a physical copy. That copy used to be
// hand-maintained behind a "keep in sync" comment, which is exactly the
// kind of invariant that rots silently: the canonical ingredient key is
// derived from this algorithm, so a divergence rekeys the lookup tables
// on one side only.
//
//   node scripts/sync-ingredient-terms.mjs           # rewrite the copy
//   node scripts/sync-ingredient-terms.mjs --check   # CI: fail if stale
import { readFileSync, writeFileSync } from 'node:fs';

const DOMAIN = 'packages/domain/src/services/ingredientTerms.ts';
const MATH = 'packages/domain/src/services/nutritionMath.ts';
const OUT = 'supabase/functions/nutrition/_ingredientTerms.ts';

const math = readFileSync(MATH, 'utf8');
const m = /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\nexport function tokenizeIngredient\(name: string\): string\[\] \{(?:(?!\n\})[\s\S])*\n\}/.exec(math);
if (!m) throw new Error(`could not extract tokenizeIngredient from ${MATH}`);
const tokenizer = m[0].replace(/^export function/m, 'function');

const domain = readFileSync(DOMAIN, 'utf8');
if (!/^import \{ tokenizeIngredient \} from '\.\/nutritionMath\.js';\n/.test(domain)) {
  throw new Error(`${DOMAIN} no longer starts with the expected tokenizeIngredient import`);
}
const body = domain.replace(/^import \{ tokenizeIngredient \} from '\.\/nutritionMath\.js';\n/, '');

const header = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerate with:  node scripts/sync-ingredient-terms.mjs
// Source of truth:  ${DOMAIN}
//                   (+ tokenizeIngredient, inlined from ${MATH})
//
// The edge function bundles only its own directory, so it cannot import
// the domain package and needs this physical copy. The contract both
// copies satisfy lives in ${DOMAIN.replace('.ts', '.test.ts')}.

`;

const next = header + tokenizer + '\n\n' + body;
const prev = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return null; } })();

if (process.argv.includes('--check')) {
  if (prev !== next) {
    console.error(`${OUT} is out of date — run: node scripts/sync-ingredient-terms.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date`);
} else {
  writeFileSync(OUT, next);
  console.log(prev === next ? `${OUT} unchanged` : `${OUT} regenerated`);
}
