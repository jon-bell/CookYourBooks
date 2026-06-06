import { test, expect } from './support/fixtures.js';
import { waitForSynced } from './support/fixtures.js';
import {
  configureOcrKey,
  seedOcrFixture,
  triggerWorker,
  uploadTestImages,
  waitForBatchItemCount,
  waitForItemStatuses,
  type FakeRecipeDraft,
} from './support/imports.js';

// Clears the Conservative auto-accept bar: one recipe, real title, 3
// ingredients, 2 instructions, nothing left unparsed.
function highConfidenceDraft(title: string): FakeRecipeDraft {
  return {
    title,
    servings: { amount: 6 },
    ingredients: [
      { type: 'MEASURED', name: 'flour', quantity: { type: 'EXACT', amount: 2, unit: 'cup' } },
      { type: 'MEASURED', name: 'sugar', quantity: { type: 'EXACT', amount: 1, unit: 'cup' } },
      { type: 'VAGUE', name: 'salt' },
    ],
    instructions: [
      { stepNumber: 1, text: 'Mix the flour, sugar, and salt.' },
      { stepNumber: 2, text: 'Bake until golden.' },
    ],
  };
}

// Below the bar: only one ingredient → must stay in manual review.
function lowConfidenceDraft(title: string): FakeRecipeDraft {
  return {
    title,
    ingredients: [
      { type: 'MEASURED', name: 'mystery', quantity: { type: 'EXACT', amount: 1, unit: 'cup' } },
    ],
    instructions: [{ stepNumber: 1, text: 'Do something.' }],
  };
}

async function batchIdFromUrl(page: import('@playwright/test').Page): Promise<string> {
  const m = new URL(page.url()).pathname.match(/\/import\/([0-9a-f-]+)/);
  if (!m) throw new Error(`Not on a batch page: ${page.url()}`);
  return m[1]!;
}

async function pickTargetCookbook(
  page: import('@playwright/test').Page,
  title: string,
): Promise<void> {
  await page.getByLabel('Target cookbook').click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await listbox.getByPlaceholder('Search cookbooks…').fill(title);
  await listbox.getByRole('option', { name: title }).first().click();
  await expect(listbox).toHaveCount(0);
}

/** Upload two pages into a fresh cookbook, seed one high- and one
 *  low-confidence OCR result, run the worker, and land on the batch board. */
async function setupBatch(
  page: import('@playwright/test').Page,
  cookbook: string,
  highTitle: string,
  lowTitle: string,
): Promise<string> {
  await configureOcrKey(page, 'gemini');
  await page.goto('/');
  await waitForSynced(page);
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(cookbook);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: cookbook })).toBeVisible();
  await waitForSynced(page);

  await page.goto('/import/new');
  await uploadTestImages(page, ['page1.png', 'page2.png']);
  await pickTargetCookbook(page, cookbook);
  await page.getByRole('button', { name: 'Start import' }).click();
  await page.waitForURL(/\/import\/[0-9a-f-]+$/);
  const batchId = await batchIdFromUrl(page);

  const items = await waitForBatchItemCount(batchId, 2);
  await seedOcrFixture({ storagePath: items[0]!.storage_path, kind: 'recipe', draft: highConfidenceDraft(highTitle) });
  await seedOcrFixture({ storagePath: items[1]!.storage_path, kind: 'recipe', draft: lowConfidenceDraft(lowTitle) });
  await triggerWorker(batchId);
  return batchId;
}

test.describe('OCR auto-accept', () => {
  test.slow();

  test('auto-accepts a high-confidence page and leaves a low-confidence one for review', async ({
    authedPage: page,
  }) => {
    const batchId = await setupBatch(page, 'Auto Bakery', 'Honey Cake', 'Murky Page');

    // The board's auto-accept pass fires as OCR_DONE rows sync in: the
    // high-confidence page is promoted (REVIEWED) without a click, the
    // low-confidence one is left as Needs review (OCR_DONE).
    await expect(page.getByText(/1 recipe auto-accepted/)).toBeVisible({ timeout: 30_000 });
    await waitForItemStatuses(batchId, (c) => c.reviewed === 1 && c.ocrDone === 1, 30_000);

    // The auto-accepted recipe is really in the cookbook; the murky one is not.
    await waitForSynced(page);
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Auto Bakery' }).click();
    await expect(page.getByText('Honey Cake')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Murky Page')).toHaveCount(0);
  });

  test('Undo returns auto-accepted pages to review and deletes the recipe', async ({
    authedPage: page,
  }) => {
    const batchId = await setupBatch(page, 'Undo Bakery', 'Plum Tart', 'Murky Page');

    await expect(page.getByText(/1 recipe auto-accepted/)).toBeVisible({ timeout: 30_000 });
    await waitForItemStatuses(batchId, (c) => c.reviewed === 1 && c.ocrDone === 1, 30_000);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();

    // Undo is a local-first action: the outbox push scrub only carries
    // REVIEWED/DISCARDED to the server, so reverting to OCR_DONE stays local.
    // Assert the board UI (which reads local): the banner clears and both
    // pages are back under Needs review. The recipe deletion does sync.
    await expect(page.getByText(/auto-accepted/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Needs review \(2\)/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: /Done \(0\)/ })).toBeVisible();

    await waitForSynced(page);
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Undo Bakery' }).click();
    await expect(page.getByText('Plum Tart')).toHaveCount(0);
  });

  test('turning auto-accept off leaves every page for manual review', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await page.goto('/');
    await waitForSynced(page);
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Manual Bakery');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Manual Bakery' })).toBeVisible();
    await waitForSynced(page);

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png']);
    await pickTargetCookbook(page, 'Manual Bakery');
    await page.getByRole('button', { name: 'Start import' }).click();
    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);

    // Turn auto-accept off before OCR completes.
    await page.getByLabel('Auto-accept obvious recipes').uncheck();

    const items = await waitForBatchItemCount(batchId, 1);
    await seedOcrFixture({ storagePath: items[0]!.storage_path, kind: 'recipe', draft: highConfidenceDraft('Should Wait') });
    await triggerWorker(batchId);

    // Even though it clears the bar, it stays in review — no banner, no promote.
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 1, 30_000);
    await expect(page.getByText(/auto-accepted/)).toHaveCount(0);
  });
});
