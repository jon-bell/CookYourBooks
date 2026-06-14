import { type Page } from '@playwright/test';
import { test, expect } from './support/fixtures.js';

// Guided Gemini-first onboarding wizard (/import/setup). The key validation
// step is shimmed via `window.__cybOcrKeyTestShim` so the spec never calls the
// real `ocr-key-test` edge function / Google — the sentinel key validates,
// anything else fails as `auth`. The actual key save still goes through the
// real `ocr_key_set` RPC, so the post-condition (import no longer prompts for
// setup) exercises the full path.

const GOOD_KEY = 'AIza-good-key-1234';

async function installKeyTestShim(page: Page): Promise<void> {
  await page.addInitScript((goodKey: string) => {
    (
      window as unknown as {
        __cybOcrKeyTestShim?: (
          provider: string,
          rawKey: string,
        ) => Promise<{ ok: boolean; reason?: string }>;
      }
    ).__cybOcrKeyTestShim = async (_provider: string, rawKey: string) =>
      rawKey === goodKey ? { ok: true } : { ok: false, reason: 'auth' };
  }, GOOD_KEY);
}

test.describe('OCR onboarding wizard', () => {
  test('walks a new user from intro to a working import setup', async ({ authedPage: page }) => {
    await installKeyTestShim(page);

    // A brand-new user has no key → the import entry nudges into setup.
    await page.goto('/import/new');
    await expect(page.getByTestId('ocr-setup-guide')).toBeVisible();
    await page.getByRole('link', { name: 'Set up importing' }).click();

    // Step 1: intro → Step 2: get key → Step 3: paste.
    await expect(page.getByTestId('ocr-wizard')).toBeVisible();
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'I have my key' }).click();

    // A wrong key is rejected inline, before anything is saved.
    await page.getByTestId('ocr-wizard-key-input').fill('not-a-real-key');
    await page.getByTestId('ocr-wizard-continue').click();
    await expect(page.getByTestId('ocr-wizard-error')).toBeVisible();

    // The good key validates, saves, and advances to the success step.
    await page.getByTestId('ocr-wizard-key-input').fill(GOOD_KEY);
    await page.getByTestId('ocr-wizard-continue').click();
    await expect(page.getByTestId('ocr-wizard-done')).toBeVisible();

    // Finishing drops the user into import, now fully set up (no more guide).
    await page.getByRole('button', { name: 'Start importing' }).click();
    await expect(page).toHaveURL(/\/import\/new$/);
    await expect(page.getByTestId('ocr-setup-guide')).toHaveCount(0);
  });

  test('skips setup when a key already exists', async ({ authedPage: page }) => {
    await installKeyTestShim(page);
    // Save a key first via the real RPC, then the wizard should short-circuit.
    const saved = await page.evaluate(async () => {
      const sb = window.__cybSupabase;
      if (!sb) return false;
      const { error } = await sb.rpc('ocr_key_set', {
        p_provider: 'gemini',
        p_raw_key: 'AIza-already-here',
      });
      return !error;
    });
    expect(saved).toBe(true);

    await page.goto('/import/setup');
    await expect(page.getByTestId('ocr-wizard-already-set')).toBeVisible();
  });
});
