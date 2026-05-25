import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './support/fixtures.js';
import {
  configureOcrKey,
  seedOcrFixture,
  triggerWorker,
} from './support/imports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures');

async function seedBakeoffFixtures(): Promise<void> {
  await seedOcrFixture({
    storagePath: 'bakeoff:*',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    kind: 'recipe',
    upsert: true,
    latencyMs: 500,
    draft: {
      title: 'Quick Cookies',
      ingredients: [
        {
          type: 'MEASURED',
          name: 'flour',
          quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
        },
      ],
      instructions: [{ stepNumber: 1, text: 'Mix everything in one bowl.' }],
    },
  });
  await seedOcrFixture({
    storagePath: 'bakeoff:*',
    provider: 'gemini',
    model: 'gemini-3-pro-image-preview',
    kind: 'recipe',
    upsert: true,
    latencyMs: 1_500,
    draft: {
      title: 'Quick Cookies (revised)',
      ingredients: [
        {
          type: 'MEASURED',
          name: 'all-purpose flour',
          quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
        },
      ],
      instructions: [
        {
          stepNumber: 1,
          text: 'Cream butter and sugar until fluffy, then fold in the dry ingredients.',
        },
      ],
    },
  });
}

async function gotoBakeoffNew(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/import/new/bakeoff');
  await expect(page.getByRole('heading', { name: 'New bakeoff' })).toBeVisible();
}

async function uploadFakeImage(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Choose images' }).click();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'recipe.png',
    mimeType: 'image/png',
    buffer: readFileSync(resolve(FIXTURES_DIR, 'page1.png')),
  });
}

async function clearVariantLocalStorage(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.evaluate(() => localStorage.removeItem('cookyourbooks.bakeoff.v1'));
}

test.describe('OCR bakeoff import', () => {
  test.slow();

  test('creates a saved bakeoff batch and races variants per page', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedBakeoffFixtures();
    await clearVariantLocalStorage(page);

    await gotoBakeoffNew(page);
    await uploadFakeImage(page);

    await expect(page.getByLabel('Variant 1 name')).toHaveValue('Gemini Flash');
    await expect(page.getByLabel('Variant 2 name')).toHaveValue('Gemini Pro');

    await page.getByTestId('bakeoff-run').click();
    await expect(page).toHaveURL(/\/import\/[0-9a-f-]+$/, { timeout: 60_000 });

    await triggerWorker();

    // Open the first reviewable page (BAKEOFF_READY).
    await expect
      .poll(
        async () => {
          const link = page.getByRole('link', { name: /Pick winner|Needs review|Running variants/i });
          return link.count();
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    await page.getByRole('link', { name: /Pick winner|Needs review/i }).first().click();
    await expect(page.getByTestId('bakeoff-item-review')).toBeVisible({ timeout: 60_000 });

    const rows = page.getByTestId('bakeoff-result-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByText('OK', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(rows.nth(1).getByText('OK', { exact: true })).toBeVisible({ timeout: 60_000 });
  });

  test('diff view highlights differences between variants', async ({ authedPage: page }) => {
    await configureOcrKey(page, 'gemini');
    await seedBakeoffFixtures();
    await clearVariantLocalStorage(page);

    await gotoBakeoffNew(page);
    await uploadFakeImage(page);
    await page.getByTestId('bakeoff-run').click();
    await expect(page).toHaveURL(/\/import\//, { timeout: 60_000 });
    await triggerWorker();

    await page.getByRole('link', { name: /Pick winner|Needs review/i }).first().click({
      timeout: 60_000,
    });
    await expect(page.getByTestId('bakeoff-diff')).toBeVisible({ timeout: 60_000 });

    const diff = page.getByTestId('bakeoff-diff');
    await expect(
      diff.locator('[data-diff-kind="add"]').filter({ hasText: 'all-purpose flour' }),
    ).toHaveCount(1);
    await expect(
      diff.locator('[data-diff-kind="del"]').filter({ hasText: 'flour' }),
    ).toHaveCount(1);
  });

  test('"Set as default" promotes a variant into user_ocr_prefs', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedBakeoffFixtures();
    await clearVariantLocalStorage(page);

    await gotoBakeoffNew(page);
    await uploadFakeImage(page);
    await page.getByTestId('bakeoff-run').click();
    await expect(page).toHaveURL(/\/import\//, { timeout: 60_000 });
    await triggerWorker();

    await page.getByRole('link', { name: /Pick winner|Needs review/i }).first().click({
      timeout: 60_000,
    });
    await expect(page.getByTestId('bakeoff-promote').first()).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('bakeoff-promote').first().click();

    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const sb = (window as unknown as {
              __cybSupabase?: {
                from: (t: string) => {
                  select: (c: string) => {
                    maybeSingle: () => Promise<{ data?: { model?: string } | null }>;
                  };
                };
              };
            }).__cybSupabase;
            const r = await sb!.from('user_ocr_prefs').select('model').maybeSingle();
            return r.data?.model ?? '';
          }),
        { timeout: 15_000 },
      )
      .toBe('gemini-2.5-flash');
  });

  test('"Bakeoff" link navigates to the new bakeoff wizard', async ({ authedPage: page }) => {
    await page.evaluate(() => {
      localStorage.setItem('cookyourbooks.import.onboarded.v1', '1');
    });
    await page.goto('/import');
    await page.getByRole('link', { name: 'Bakeoff' }).click();
    await expect(page).toHaveURL(/\/import\/new\/bakeoff$/);
    await expect(page.getByRole('heading', { name: 'New bakeoff' })).toBeVisible();
  });
});
