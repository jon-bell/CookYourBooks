import { test, expect, signIn } from './support/fixtures.js';
import { IPHONE_17_USE } from './support/viewport.js';
import { expectNoHorizontalOverflow } from './support/layout.js';
import { createRecipeViaUi } from './support/helpers.js';
import { seedUserLibrary } from './support/admin.js';
import {
  installScanShim,
  seedOcrFixture,
  configureOcrKey,
  pumpWorker,
  waitForBatchItemCount,
  waitForItemStatuses,
} from './support/imports.js';

// A recipe title long enough to overflow a 402px row if it didn't wrap.
const LONG_TITLE =
  'Grandmothers Slow Braised Short Rib Ragu with Hand Cut Pappardelle Gremolata and Shaved Parmigiano Reggiano';

// Every test in this file runs at the iPhone-17 logical viewport (402×874).
// `test.use` overrides the project default and applies to both `page` and
// `authedPage`. Run just this layer with `playwright test -p mobile`.
test.use({ ...IPHONE_17_USE });

test.describe('Mobile layout (iPhone 17, 402px)', () => {
  test('library page fits the viewport with no horizontal overflow', async ({
    authedPage: page,
  }) => {
    await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('sync diagnostics modal fits the viewport', async ({ authedPage: page }) => {
    // The authedPage fixture has already waited for the 'Synced' badge.
    await page.getByRole('button', { name: /Sync status/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Sync diagnostics' });
    await expect(dialog).toBeVisible();
    // The modal must not push the document wider than the screen, and its
    // own frame must contain its (horizontally-scrollable) inner tables.
    await expectNoHorizontalOverflow(page);
    await expectNoHorizontalOverflow(dialog);
  });

  test('long recipe titles wrap instead of overflowing the list', async ({
    authedPage: page,
  }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Mobile Ragu Book',
      recipeTitle: LONG_TITLE,
      ingredients: [{ kind: 'vague', name: 'salt' }],
      steps: ['Braise low and slow.'],
    });
    // Back to the collection page, which renders the recipe list.
    await page.goto('/');
    await page.getByRole('link', { name: /Mobile Ragu Book/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Mobile Ragu Book' })).toBeVisible();

    // The full title stays in the DOM (line-clamp only clips the paint)…
    await expect(page.getByText(LONG_TITLE)).toBeVisible();
    // …and neither the row nor the page overflows horizontally.
    const row = page.locator('main a[href*="/recipes/"]').first();
    await expectNoHorizontalOverflow(row);
    await expectNoHorizontalOverflow(page);
  });

  test('header collapses into a hamburger sheet that reaches every link', async ({
    authedPage: page,
  }) => {
    const menuButton = page.getByRole('button', { name: 'Open menu' });
    await expect(menuButton).toBeVisible();
    await menuButton.click();

    const sheet = page.getByRole('navigation', { name: 'Mobile' });
    await expect(sheet).toBeVisible();
    for (const label of [
      'Library',
      'Discover',
      'Search',
      'Shopping',
      'Cooking',
      'Import',
      'Household',
      'Activity',
      'Settings',
    ]) {
      await expect(sheet.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);

    // Tapping a link navigates and dismisses the sheet.
    await sheet.getByRole('link', { name: 'Shopping', exact: true }).click();
    await expect(page).toHaveURL(/\/shopping$/);
    await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeHidden();
  });

  test('in-collection filter narrows the list and the index view renders', async ({
    page,
    user,
  }) => {
    // Seed a multi-recipe cookbook server-side, then sign in so the first
    // pull hydrates it into the local cache.
    const { collectionId } = await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Big Cookbook',
      recipeCount: 12,
    });
    await signIn(page, user);
    await page.goto(`/collections/${collectionId}`);
    await expect(page.getByRole('heading', { name: 'Big Cookbook' })).toBeVisible();
    await expect(page.getByText('Perf Recipe 1', { exact: true })).toBeVisible();

    // Filtering to one title hides the rest.
    const filter = page.getByRole('searchbox', { name: 'Filter recipes in this collection' });
    await filter.fill('Perf Recipe 12');
    await expect(page.getByText('Perf Recipe 12', { exact: true })).toBeVisible();
    await expect(page.getByText('Perf Recipe 11', { exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // Clearing + switching to the dense index keeps every recipe reachable.
    await filter.fill('');
    await page.getByRole('button', { name: 'Index view' }).click();
    await expect(page.getByText('Perf Recipe 5', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('scan pages creates a batch and OCRs every captured page', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    // Bypass the live camera with two canned page images.
    await installScanShim(page, ['page1.png', 'page2.png']);

    await page.goto('/import/scan');
    await page.getByRole('button', { name: 'Scan pages' }).click();

    // Lands on the batch board for the freshly-created batch.
    await page.waitForURL(/\/import\/[0-9a-f-]+$/, { timeout: 30_000 });
    const batchId = page.url().split('/import/')[1]!.split(/[/?#]/)[0]!;

    // Two captured frames → two import items. Seed a fixture per actual
    // storage path, scoped to provider 'gemini' — the worker probes
    // (path, gemini, '') before any (*, …) wildcard, so this can neither
    // hijack nor be hijacked by other OCR specs sharing the DB. Then run
    // the mock worker (the page's ocr_kick is a no-op without a vault key).
    const items = await waitForBatchItemCount(batchId, 2);
    for (const item of items) {
      await seedOcrFixture({
        storagePath: item.storage_path,
        provider: 'gemini',
        kind: 'recipe',
        draft: {
          title: 'Scanned Recipe',
          ingredients: [{ type: 'VAGUE', name: 'salt' }],
          instructions: [{ stepNumber: 1, text: 'Cook it.' }],
        },
      });
    }
    await pumpWorker();
    await waitForItemStatuses(batchId, (c) => c.ocrDone + c.reviewed >= 2, 60_000);
    await expectNoHorizontalOverflow(page);
  });
});
