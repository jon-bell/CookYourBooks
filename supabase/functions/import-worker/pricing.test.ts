// Unit tests for OCR cost math. Run with: deno test pricing.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { costFromMap, seedFromBundled } from './pricing.ts';

Deno.test('bundled snapshot prices the app default models (not $0)', () => {
  const map = seedFromBundled();
  // 1M prompt + 1M completion tokens makes the math read directly in USD.
  // gpt-5.4 = 2.50 in / 15.00 out => $17.50 => 17_500_000 micro-USD.
  assertEquals(costFromMap(map, 'openai-compatible', 'gpt-5.4', 1_000_000, 1_000_000), 17_500_000);
  // gemini-3.1-flash-lite = 0.25 / 1.50 => $1.75 => 1_750_000.
  assertEquals(costFromMap(map, 'gemini', 'gemini-3.1-flash-lite', 1_000_000, 1_000_000), 1_750_000);
});

Deno.test('cost scales linearly and rounds to whole micro-USD', () => {
  const map = seedFromBundled();
  // gpt-4o = 2.50 / 10.00. 1000 prompt + 500 completion:
  // (1000*2.5 + 500*10)/1e6 = 0.0075 USD => 7500 micro-USD.
  assertEquals(costFromMap(map, 'openai-compatible', 'gpt-4o', 1000, 500), 7500);
});

Deno.test('an unmapped model falls back (does not throw) — must be logged loudly', () => {
  const map = seedFromBundled();
  // No rate anywhere => bundled fallback (0). The function logs an error to
  // console; here we just assert it does not silently invent a cost.
  assertEquals(costFromMap(map, 'gemini', 'made-up-model-9000', 1_000_000, 1_000_000), 0);
});

Deno.test('a model present in the runtime map overrides the bundled rate', () => {
  const map = seedFromBundled();
  map.set('gemini:gemini-3.1-flash-lite', {
    input_usd_per_mtok: 1,
    output_usd_per_mtok: 2,
  });
  // (1e6*1 + 1e6*2)/1e6 = $3 => 3_000_000.
  assertEquals(costFromMap(map, 'gemini', 'gemini-3.1-flash-lite', 1_000_000, 1_000_000), 3_000_000);
});
