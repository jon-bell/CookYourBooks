import { expect, test, waitForSynced } from './support/fixtures.js';
import { configureOcrKey, installScanShim, pumpWorker, seedOcrFixture } from './support/imports.js';

const FAKE_DRAFTS = [
  {
    title: 'Chewy Cookies',
    bookTitle: 'Weekend Baking',
    pageNumbers: [42],
    servings: { amount: 24 },
    ingredients: [
      {
        type: 'MEASURED' as const,
        name: 'flour',
        quantity: { type: 'EXACT' as const, amount: 2, unit: 'cup' },
      },
      { type: 'VAGUE' as const, name: 'salt' },
    ],
    instructions: [{ stepNumber: 1, text: 'Mix 2 cup flour with the salt.' }],
  },
  {
    title: 'Crispy Cookies',
    bookTitle: 'Weekend Baking',
    pageNumbers: [43],
    servings: { amount: 18 },
    ingredients: [
      {
        type: 'MEASURED' as const,
        name: 'flour',
        quantity: { type: 'EXACT' as const, amount: 1.5, unit: 'cup' },
      },
    ],
    instructions: [{ stepNumber: 1, text: 'Roll thin and bake.' }],
  },
];

async function seedMultiRecipeFixture(): Promise<void> {
  // Wildcard path so the page-generated storage path matches. The
  // worker's `(*, gemini, '')` probe picks this up regardless of which
  // model the batch is configured with.
  await seedOcrFixture({
    storagePath: '*',
    provider: 'gemini',
    kind: 'recipe',
    upsert: true,
    drafts: FAKE_DRAFTS,
  });
}

/**
 * Scan one page into a fresh cookbook and land on its review item. A single
 * captured page skips grouping, so the two drafts show up as tabs directly.
 */
async function scanAndOpenItem(
  page: import('@playwright/test').Page,
  collectionTitle: string,
): Promise<void> {
  await installScanShim(page, ['page1.png']);

  await page.goto('/library');
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(collectionTitle);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: collectionTitle })).toBeVisible();

  await page.getByRole('link', { name: 'Scan pages', exact: true }).click();
  await page.waitForURL(/\/import\/scan\?collection=[0-9a-f-]+$/);
  await page.getByRole('button', { name: 'Scan pages' }).click();

  // A single captured page skips grouping and lands on review immediately —
  // before OCR has run — so pump the worker once we're there. The test env has
  // no vault secret, so ocr_kick is a no-op; pumpWorker retries until the
  // asynchronous outbox push has made the row visible server-side.
  await page.waitForURL(/\/import\/[0-9a-f-]+\/items\/[0-9a-f-]+/, { timeout: 30_000 });
  await pumpWorker();
}

test.describe('OCR multi-recipe review editor', () => {
  test.slow();

  test('two drafts arrive as tabs; promoting both lands two recipes and moves the item to REVIEWED', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedMultiRecipeFixture();
    await scanAndOpenItem(page, 'Multi-Recipe Photo');

    const tabs = page.getByTestId('draft-tabs');
    // Drafts arrive over realtime once the worker writes them.
    await expect(tabs.getByRole('tab', { name: 'Chewy Cookies' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(tabs.getByRole('tab', { name: 'Crispy Cookies' })).toBeVisible();

    await page.getByRole('button', { name: 'Save as recipe' }).first().click();
    await expect(tabs).toHaveCount(0);

    await page.getByRole('button', { name: 'Save as recipe' }).first().click();
    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    await waitForSynced(page);

    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Multi-Recipe Photo' }).click();
    await expect(page.getByText('Chewy Cookies')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Crispy Cookies')).toBeVisible();
  });

  test('discarding one draft and promoting the other still moves the item to REVIEWED', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedMultiRecipeFixture();
    await scanAndOpenItem(page, 'Discard-One Photo');

    await expect(page.getByTestId('draft-tabs')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Discard this draft' }).click();
    await expect(page.getByTestId('draft-tabs')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save as recipe' }).first().click();
    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    await waitForSynced(page);

    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Discard-One Photo' }).click();
    await expect(page.getByText('Crispy Cookies')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Chewy Cookies')).toHaveCount(0);
  });
});
