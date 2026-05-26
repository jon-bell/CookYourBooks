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
    // Matches the second seed variant in DEFAULT_VARIANTS — keep in
    // sync with DEFAULT_MODEL_BY_PROVIDER.gemini in src/settings/ocrSettings.ts.
    model: 'gemini-3.1-flash-lite',
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

/**
 * Drive the new bakeoff page from variant matrix to the batch board:
 * click "Run bakeoff" → confirm the (default group-first) grouping
 * step → land on `/import/{batchId}`. Returns the batch id parsed
 * out of the final URL so tests can use it for downstream queries
 * if needed.
 *
 * The bakeoff page defaults to `group-first` mode, so every run
 * lands at `/import/{id}/group` first and the user must click
 * "Start OCR on N recipe" to advance to OCR.
 */
async function runBakeoffAndConfirmGrouping(
  page: import('@playwright/test').Page,
): Promise<string> {
  await page.getByTestId('bakeoff-run').click();
  // First stop: the grouping page. URL has /group on the end.
  await expect(page).toHaveURL(/\/import\/[0-9a-f-]+\/group$/, { timeout: 60_000 });
  // Confirm the default grouping (one recipe per page) and kick OCR.
  await page.getByRole('button', { name: /Start OCR on \d+ recipe/ }).click();
  // Second stop: the batch board. Strip the trailing /group.
  await expect(page).toHaveURL(/\/import\/[0-9a-f-]+$/, { timeout: 60_000 });
  const m = page.url().match(/\/import\/([0-9a-f-]+)$/);
  if (!m) throw new Error(`could not parse batch id from ${page.url()}`);
  return m[1]!;
}

/**
 * After kicking the import-worker, wait for at least one bakeoff item
 * to land on the user-actionable BAKEOFF_READY state (visible as a
 * "Pick winner" or "Needs review" link on the batch board). The mock
 * worker is fast enough that a single triggerWorker call usually drains
 * every variant, but realtime → local-DB → React Query propagation
 * takes a beat or two; this helper re-kicks the worker on each poll
 * iteration to absorb both the variant fan-out latency and any rare
 * lease-loss retries.
 */
async function waitForBakeoffReady(
  page: import('@playwright/test').Page,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await triggerWorker();
        return page
          .getByRole('link', { name: /Pick winner|Needs review/i })
          .count();
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(0);
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

    await runBakeoffAndConfirmGrouping(page);

    // Pump the worker until the item lands on BAKEOFF_READY ("Pick winner").
    await waitForBakeoffReady(page);

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
    await runBakeoffAndConfirmGrouping(page);
    await waitForBakeoffReady(page);

    await page.getByRole('link', { name: /Pick winner|Needs review/i }).first().click({
      timeout: 60_000,
    });
    // The new BakeoffItemReview shows a side-by-side "Compare" panel
    // with one <article> per variant (instead of the old textual
    // unified diff). Verify the two seeded fixtures render distinct
    // drafts so the user can compare them visually.
    await expect(page.getByTestId('bakeoff-diff')).toBeVisible({ timeout: 60_000 });
    const diff = page.getByTestId('bakeoff-diff');
    await expect(diff.getByRole('heading', { level: 3, name: 'Compare' })).toBeVisible();
    const articles = diff.locator('article');
    await expect(articles).toHaveCount(2);
    // The Pro fixture uses "all-purpose flour"; the Flash fixture uses
    // just "flour". Both should be visible in the compare panel, in
    // their respective articles.
    await expect(diff.getByText('all-purpose flour', { exact: true })).toHaveCount(1);
    // Match a standalone "flour" cell (avoid the "all-purpose flour" substring).
    await expect(
      diff.locator('article').filter({ hasText: /^.*Quick Cookies.*/ }).filter({ hasNotText: 'revised' }),
    ).toContainText('flour');
  });

  test('"Set as default" promotes a variant into user_ocr_prefs', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedBakeoffFixtures();
    await clearVariantLocalStorage(page);

    await gotoBakeoffNew(page);
    await uploadFakeImage(page);
    await runBakeoffAndConfirmGrouping(page);
    await waitForBakeoffReady(page);

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
