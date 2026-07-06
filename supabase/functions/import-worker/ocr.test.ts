// Unit tests for Gemini answer-part extraction. Run with: deno test ocr.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { extractGeminiText } from './ocr.ts';

Deno.test('reads the answer text off a single part', () => {
  assertEquals(
    extractGeminiText({ content: { parts: [{ text: '{"recipes":[]}' }] } }),
    '{"recipes":[]}',
  );
});

Deno.test('keeps the answer part that carries a thoughtSignature (gemini-3.x)', () => {
  // The gemini-3.5-flash OCR response attaches a thoughtSignature to the
  // answer part itself — that part must still be read.
  assertEquals(
    extractGeminiText({
      content: { parts: [{ text: '{"recipes":[]}', thoughtSignature: 'Eq5b...' }] },
    }),
    '{"recipes":[]}',
  );
});

Deno.test('skips thought-summary parts and keeps the answer', () => {
  assertEquals(
    extractGeminiText({
      content: {
        parts: [
          { text: 'Let me read the page and extract the recipe...', thought: true },
          { text: '{"recipes":[{"title":"X"}]}' },
        ],
      },
    }),
    '{"recipes":[{"title":"X"}]}',
  );
});

Deno.test('concatenates an answer split across multiple parts', () => {
  assertEquals(
    extractGeminiText({
      content: { parts: [{ text: '{"recipes":' }, { text: '[{"title":"Y"}]}' }] },
    }),
    '{"recipes":[{"title":"Y"}]}',
  );
});

Deno.test('returns undefined when there is no answer text', () => {
  assertEquals(extractGeminiText({ content: { parts: [{ thought: true, text: 'thinking' }] } }), undefined);
  assertEquals(extractGeminiText({ content: { parts: [] } }), undefined);
  assertEquals(extractGeminiText({}), undefined);
  assertEquals(extractGeminiText(undefined), undefined);
});
