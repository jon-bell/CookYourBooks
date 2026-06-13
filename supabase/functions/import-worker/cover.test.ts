import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildCollectionCoverPrompt, buildCoverPrompt, extForMime } from './cover.ts';

const TEMPLATE =
  'A thumbnail to put on a recipe card for this recipe, RECIPE NAME. Ingredients <INGREDIENTS>. Instructions <INSTRUCTIONS>';

Deno.test('buildCoverPrompt substitutes all three tokens', () => {
  const out = buildCoverPrompt(TEMPLATE, {
    title: 'Lemon Cake',
    ingredients: ['flour', 'lemon', 'sugar'],
    instructions: ['Mix.', 'Bake.'],
  });
  assertEquals(
    out,
    'A thumbnail to put on a recipe card for this recipe, Lemon Cake. Ingredients flour, lemon, sugar. Instructions Mix. Bake.',
  );
});

Deno.test('buildCoverPrompt falls back when lists are empty', () => {
  const out = buildCoverPrompt(TEMPLATE, { title: '', ingredients: [], instructions: [] });
  assertEquals(
    out,
    'A thumbnail to put on a recipe card for this recipe, this dish. Ingredients n/a. Instructions n/a',
  );
});

Deno.test('buildCoverPrompt filters blanks and truncates long instructions', () => {
  const long = 'x'.repeat(2000);
  const out = buildCoverPrompt('<INGREDIENTS>|<INSTRUCTIONS>', {
    title: 'T',
    ingredients: ['salt', '', '  '],
    instructions: [long],
  });
  const [ing, instr] = out.split('|');
  assertEquals(ing, 'salt');
  assertEquals(instr.length, 1500);
});

Deno.test('buildCollectionCoverPrompt includes title, ToC, and a no-text instruction', () => {
  const out = buildCollectionCoverPrompt('Grandma’s Bakes', ['Lemon Cake', 'Scones', '']);
  assertStringIncludes(out, 'Grandma’s Bakes');
  assertStringIncludes(out, 'Lemon Cake, Scones');
  assertStringIncludes(out, '2:3 portrait');
  assertStringIncludes(out, 'do not render any text');
});

Deno.test('buildCollectionCoverPrompt caps the table of contents at 30 titles', () => {
  const titles = Array.from({ length: 50 }, (_, i) => `Recipe ${i + 1}`);
  const out = buildCollectionCoverPrompt('Big Book', titles);
  assertStringIncludes(out, 'Recipe 30');
  assertEquals(out.includes('Recipe 31'), false);
});

Deno.test('buildCollectionCoverPrompt omits the ToC clause when there are no recipes', () => {
  const out = buildCollectionCoverPrompt('Empty', []);
  assertEquals(out.includes('includes recipes such as'), false);
});

Deno.test('extForMime maps common image mimes', () => {
  assertEquals(extForMime('image/png'), 'png');
  assertEquals(extForMime('image/jpeg'), 'jpg');
  assertEquals(extForMime('image/webp'), 'webp');
  assertEquals(extForMime('application/octet-stream'), 'png');
});
