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

/**
 * The OCR bakeoff page uploads one image, kicks the worker, and watches
 * each variant's row in `bakeoff_variants` settle. The worker is in
 * mock mode (`OCR_MOCK_MODE=1`), so we seed one fixture per
 * (provider, model) so each variant returns a distinct draft. Fixtures
 * use the `*` wildcard path because the page-generated storage path is
 * a random UUID we can't predict.
 */

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

async function gotoBakeoff(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/import/bakeoff');
  await expect(page.getByRole('heading', { name: 'OCR bakeoff' })).toBeVisible();
}

async function uploadFakeImage(page: import('@playwright/test').Page): Promise<void> {
  // BakeoffPage runs the file through `prepareImage`, which actually
  // decodes the image via the browser's canvas API; a synthetic
  // minimum-length PNG isn't enough. Reuse the same fixture image the
  // bulk-import tests use.
  await page.getByTestId('bakeoff-file-input').setInputFiles({
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

test.describe('OCR bakeoff', () => {
  test.slow();

  test('races two variants against the same photo and shows per-variant cost / latency / output', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedBakeoffFixtures();
    await clearVariantLocalStorage(page);

    await gotoBakeoff(page);

    // Default matrix is the two seed variants — verify both render.
    await expect(page.getByLabel('Variant 1 name')).toHaveValue('Gemini Flash');
    await expect(page.getByLabel('Variant 2 name')).toHaveValue('Gemini Pro');

    await uploadFakeImage(page);
    await page.getByTestId('bakeoff-run').click();

    // The page calls ocr_kick once `bakeoff_start` returns, but the
    // worker's import_worker_config vault secret isn't set in the test
    // env, so we drive the worker by hand. Wait for the result rows to
    // render first (proves the run + variants are persisted) before
    // kicking, otherwise the worker sees an empty queue.
    const rows = page.getByTestId('bakeoff-result-row');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await triggerWorker();

    // Each row should reach OK status. `exact: true` is critical —
    // Playwright's default text matching is case-insensitive substring,
    // which matches "ok" inside "Cookies".
    await expect(rows.nth(0).getByText('OK', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(rows.nth(1).getByText('OK', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // Token usage from the mock fixtures (the __mock_usage stub seeds
    // 100 / 200 for every recipe-kind fixture).
    await expect(rows.nth(0)).toContainText('100 / 200');
    await expect(rows.nth(1)).toContainText('100 / 200');

    // Per-fixture latency comes through verbatim.
    await expect(rows.nth(0)).toContainText('0.50 s');
    await expect(rows.nth(1)).toContainText('1.50 s');

    // Each row surfaces the parsed title in the output summary cell.
    await expect(rows.nth(0)).toContainText('Quick Cookies');
    await expect(rows.nth(1)).toContainText('Quick Cookies (revised)');
  });

  test('diff view highlights additions and deletions between two variants', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedBakeoffFixtures();
    await clearVariantLocalStorage(page);

    await gotoBakeoff(page);
    await uploadFakeImage(page);
    await page.getByTestId('bakeoff-run').click();
    await expect(page.getByTestId('bakeoff-result-row')).toHaveCount(2, {
      timeout: 30_000,
    });
    await triggerWorker();

    const diff = page.getByTestId('bakeoff-diff');
    await expect(diff).toBeVisible({ timeout: 30_000 });

    await expect(page.getByLabel('Diff left variant')).toHaveValue(/.+/);
    await expect(page.getByLabel('Diff right variant')).toHaveValue(/.+/);

    // The diff text exists — at minimum it contains an added line for
    // "all-purpose flour" (only in the pro variant) and a deletion for
    // the bare "flour" name from the flash variant. Filter to specific
    // hunks since title + step lines also appear as add / del.
    await expect(
      diff.locator('[data-diff-kind="add"]').filter({ hasText: 'all-purpose flour' }),
    ).toHaveCount(1);
    await expect(
      diff.locator('[data-diff-kind="del"]').filter({ hasText: '2 cup flour' }),
    ).toHaveCount(1);
  });

  test('"Set as default" promotes a variant into user_ocr_prefs', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedBakeoffFixtures();
    await clearVariantLocalStorage(page);

    await gotoBakeoff(page);
    await uploadFakeImage(page);
    await page.getByTestId('bakeoff-run').click();
    const rows = page.getByTestId('bakeoff-result-row');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await triggerWorker();

    await expect(rows.nth(0).getByText('OK', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // Click promote, *then* re-locate the button — the row re-renders
    // when results stream in (the `promotedId` lift) and the original
    // element-handle goes stale. Skip the toContainText assertion: just
    // verify the side effect.
    await rows.nth(0).getByTestId('bakeoff-promote').click();
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
        { timeout: 15_000, intervals: [500, 1000, 2000] },
      )
      .toBe('gemini-2.5-flash');

    // /settings should now reflect the promoted model. The form's
    // useEffect-driven load lands asynchronously after mount, so use a
    // generous timeout on the value assertion.
    await page.goto('/settings');
    await expect(page.getByLabel('Default model')).toHaveValue('gemini-2.5-flash', {
      timeout: 10_000,
    });
  });

  test('variants persist to localStorage and survive a reload', async ({
    authedPage: page,
  }) => {
    await clearVariantLocalStorage(page);

    await gotoBakeoff(page);
    await page.getByLabel('Variant 1 name').fill('My Custom Variant');
    await page.getByLabel('Variant 1 name').press('Tab');

    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('cookyourbooks.bakeoff.v1') ?? '[]'),
    );
    expect(stored[0]?.name).toBe('My Custom Variant');

    await page.reload();
    await expect(page.getByLabel('Variant 1 name')).toHaveValue('My Custom Variant');
  });

  test('blocks "Run bakeoff" until an image is selected', async ({ authedPage: page }) => {
    await clearVariantLocalStorage(page);
    await gotoBakeoff(page);
    await expect(page.getByTestId('bakeoff-run')).toBeDisabled();
    await uploadFakeImage(page);
    await expect(page.getByTestId('bakeoff-run')).toBeEnabled();
  });

  test('"Bakeoff" link on the Import list navigates to the bakeoff page', async ({
    authedPage: page,
  }) => {
    // ImportListPage auto-opens its onboarding modal on first visit; the
    // modal's full-screen overlay intercepts clicks until dismissed. Set
    // the same flag the modal sets so the link is reachable.
    await page.evaluate(() => {
      localStorage.setItem('cookyourbooks.import.onboarded.v1', '1');
    });
    await page.goto('/import');
    await page.getByRole('link', { name: 'Bakeoff' }).click();
    await expect(page).toHaveURL(/\/import\/bakeoff$/);
    await expect(page.getByRole('heading', { name: 'OCR bakeoff' })).toBeVisible();
  });
});
