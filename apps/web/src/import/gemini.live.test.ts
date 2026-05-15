import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLlmJson } from './llm.js';
import { DEFAULT_PROMPT } from '../settings/ocrSettings.js';

// Live Gemini integration test. Hits the real Google API with the
// shipped DEFAULT_PROMPT against the fixtures in repo-root /test-images.
// Auto-skips when GEMINI_API_KEY is not present so CI / contributors
// without a key see a green run.

const HERE = dirname(fileURLToPath(import.meta.url));
// src/import → apps/web → apps → <repo>
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const IMAGE_DIR = join(REPO_ROOT, 'test-images');
const ENV_CANDIDATES = [
  join(REPO_ROOT, '.env'),
  join(REPO_ROOT, '.env.local'),
  // Convention in this repo: `.secrets` (gitignored) holds keys that
  // shouldn't go in `.env.local` next to the public Supabase URL.
  join(REPO_ROOT, '.secrets'),
  join(REPO_ROOT, 'apps', 'web', '.env'),
  join(REPO_ROOT, 'apps', 'web', '.env.local'),
];

function parseEnvLine(line: string): [string, string] | undefined {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (!m) return undefined;
  let v = m[2]!;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return [m[1]!, v];
}

function loadGeminiKey(): string | undefined {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  for (const path of ENV_CANDIDATES) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      if (!raw || raw.startsWith('#')) continue;
      const parsed = parseEnvLine(raw);
      if (parsed && parsed[0] === 'GEMINI_API_KEY' && parsed[1]) return parsed[1];
    }
  }
  return undefined;
}

async function callGemini(
  imageB64: string,
  mime: string,
  model: string,
  apiKey: string,
): Promise<GeminiResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: DEFAULT_PROMPT },
            { inline_data: { mime_type: mime, data: imageB64 } },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
      safetyRatings?: unknown;
    }>;
    promptFeedback?: unknown;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (text) return { kind: 'ok', text };
  return {
    kind: 'blocked',
    finishReason: data.candidates?.[0]?.finishReason ?? 'UNKNOWN',
    detail:
      `safety=${JSON.stringify(data.candidates?.[0]?.safetyRatings ?? null)}, ` +
      `promptFeedback=${JSON.stringify(data.promptFeedback ?? null)}`,
  };
}

type GeminiResult =
  | { kind: 'ok'; text: string }
  | { kind: 'blocked'; finishReason: string; detail: string };

async function callGeminiWithRetry(
  imageB64: string,
  mime: string,
  model: string,
  apiKey: string,
): Promise<GeminiResult> {
  // One retry absorbs transient empty-text responses from the preview
  // model. RECITATION / SAFETY blocks are sticky — don't waste a retry
  // on them.
  const first = await callGemini(imageB64, mime, model, apiKey);
  if (first.kind === 'ok') return first;
  if (first.finishReason === 'RECITATION' || first.finishReason === 'SAFETY') return first;
  return callGemini(imageB64, mime, model, apiKey);
}

const KEY = loadGeminiKey();
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3-pro-image-preview';
// One round-trip can take 20–40 s on the big model; allow plenty of headroom.
const TEST_TIMEOUT = 90_000;

const IMAGES: Array<{ file: string; mime: string }> = [
  { file: 'recipe1.jpg', mime: 'image/jpeg' },
  { file: 'recipe2.png', mime: 'image/png' },
  { file: 'recipe3.jpg', mime: 'image/jpeg' },
];

describe.skipIf(!KEY)(`Gemini OCR (live, model=${MODEL})`, () => {
  for (const { file, mime } of IMAGES) {
    it(
      `extracts a usable recipe from ${file}`,
      async () => {
        const imagePath = join(IMAGE_DIR, file);
        expect(existsSync(imagePath), `missing fixture ${imagePath}`).toBe(true);
        const b64 = readFileSync(imagePath).toString('base64');

        const result = await callGeminiWithRetry(b64, mime, MODEL, KEY!);

        if (result.kind === 'blocked') {
          // Gemini sometimes refuses content too similar to its training
          // data (RECITATION) or trips a safety classifier on otherwise
          // benign cookbook scans. Surface a loud warning so we notice
          // regressions in coverage, but don't fail the suite — the model
          // is the bottleneck, not our code, and a hard fail here would
          // make the live test feel flaky.
          console.warn(
            `[gemini.live] ${file}: blocked by Gemini (finishReason=${result.finishReason}). ${result.detail}`,
          );
          return;
        }

        const raw = result.text;
        const drafts = parseLlmJson(raw);

        // Always one or more drafts; the parser guarantees at least an empty
        // shell, but with a real photo we expect at least one populated one.
        expect(drafts.length).toBeGreaterThanOrEqual(1);
        const populated = drafts.filter(
          (d) => (d.title?.length ?? 0) > 0 && d.ingredients.length > 0,
        );
        expect(
          populated.length,
          `no populated draft. raw=${raw.slice(0, 500)}`,
        ).toBeGreaterThanOrEqual(1);

        const first = populated[0]!;
        expect(first.title!.trim().length).toBeGreaterThan(0);
        expect(first.ingredients.length).toBeGreaterThan(0);
        expect(first.instructions.length).toBeGreaterThan(0);

        // Every measured ingredient must carry a canonical unit (the
        // parser maps catalog keys like "CUP" → "cup"). If this fails
        // it usually means the prompt drifted or the model returned an
        // unknown unit token.
        for (const ing of first.ingredients) {
          if (ing.type === 'MEASURED') {
            expect(typeof ing.quantity.unit).toBe('string');
            expect(ing.quantity.unit.length).toBeGreaterThan(0);
          }
        }

        // Step numbers are 1-based and monotonically increasing.
        let last = 0;
        for (const step of first.instructions) {
          expect(step.stepNumber).toBeGreaterThan(last);
          last = step.stepNumber;
        }

        // Leftover should be empty for a clean photo — if the parser
        // had to quarantine something, surface it in the failure for
        // debugging.
        expect(first.leftover, `quarantined: ${first.leftover.join(' | ')}`).toEqual([]);
      },
      TEST_TIMEOUT,
    );
  }
});

if (!KEY) {
  // Make the skip visible in the reporter rather than silently passing.
  describe('Gemini OCR (live)', () => {
    it.skip('GEMINI_API_KEY not set — live Gemini tests skipped', () => {});
  });
}
