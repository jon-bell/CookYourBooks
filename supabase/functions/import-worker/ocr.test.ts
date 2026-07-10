// Unit tests for Gemini answer-part extraction. Run with: deno test ocr.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { classifyOpenAIFinish, extractGeminiText } from './ocr.ts';

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

// ---------- classifyOpenAIFinish ----------
// A `content_filter` stop truncates the JSON mid-value while still returning
// HTTP 200 + partial content; without classification it surfaced as a bogus
// "Could not parse LLM JSON" (observed with gpt-5.4 on a steak recipe).

Deno.test('classifyOpenAIFinish: stop / absent are clean finishes', () => {
  assertEquals(classifyOpenAIFinish('stop'), 'ok');
  assertEquals(classifyOpenAIFinish(undefined), 'ok');
});

Deno.test('classifyOpenAIFinish: length is a truncation, not a refusal', () => {
  assertEquals(classifyOpenAIFinish('length'), 'truncated');
});

Deno.test('classifyOpenAIFinish: content_filter and unknown values are refusals', () => {
  assertEquals(classifyOpenAIFinish('content_filter'), 'refusal');
  assertEquals(classifyOpenAIFinish('tool_calls'), 'refusal');
  assertEquals(classifyOpenAIFinish('flagged'), 'refusal');
});
