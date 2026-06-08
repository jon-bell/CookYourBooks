import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildCoverPrompt, extForMime } from './cover.ts';

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

Deno.test('extForMime maps common image mimes', () => {
  assertEquals(extForMime('image/png'), 'png');
  assertEquals(extForMime('image/jpeg'), 'jpg');
  assertEquals(extForMime('image/webp'), 'webp');
  assertEquals(extForMime('application/octet-stream'), 'png');
});
