import { expect, test } from './support/fixtures.js';
import { waitForSynced } from './support/fixtures.js';
import {
  configureOcrKey,
  seedOcrFixture,
  triggerWorker,
  uploadTestImages,
  waitForBatchItemCount,
  waitForItemKind,
  waitForItemStatuses,
} from './support/imports.js';

async function batchIdFromUrl(page: import('@playwright/test').Page): Promise<string> {
  const url = new URL(page.url());
  const m = url.pathname.match(/\/import\/([0-9a-f-]+)/);
  if (!m) throw new Error(`Not on a batch page: ${url.pathname}`);
  return m[1]!;
}

async function createCookbook(
  page: import('@playwright/test').Page,
  title: string,
): Promise<void> {
  await page.goto('/library');
  await waitForSynced(page);
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await waitForSynced(page);
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

test.describe('OCR notes pages', () => {
  test.slow();

  test('an intro/notes page OCRs into prose and auto-files under the cookbook', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await createCookbook(page, 'Foreword Cookbook');

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png']);
    await page.getByLabel('Batch name').fill('Notes Batch');
    await pickTargetCookbook(page, 'Foreword Cookbook');
    await page.getByRole('button', { name: 'Start import' }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);
    const items = await waitForBatchItemCount(batchId, 1);
    const item = items[0]!;

    await seedOcrFixture({
      storagePath: item.storage_path,
      provider: 'gemini',
      kind: 'notes',
      note: {
        title: 'About This Book',
        body: 'A love letter to slow cooking, written over ten winters.',
      },
    });

    // Mark the page as an intro/notes page (re-arms it for the NOTES prompt),
    // confirm the kind reached the server, then run the worker.
    await page.goto(`/import/${batchId}/items/${item.id}`);
    await page.getByText('This is an intro / notes page').click();
    await waitForSynced(page);
    await waitForItemKind(item.id, 'NOTES');

    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 1, 45_000);

    // The note is auto-filed under the cookbook — it shows in its Notes section.
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Foreword Cookbook' }).click();
    // Reload so SyncProvider re-boots and pulls the worker-filed note (a plain
    // SPA nav + waitForSynced only waits for an idle indicator, not a new pull).
    await page.reload();
    await waitForSynced(page);
    await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('About This Book')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('A love letter to slow cooking, written over ten winters.'),
    ).toBeVisible();
  });

  test('a page misread as a recipe can be re-read as a note (no duplicate)', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await createCookbook(page, 'ReNote Cookbook');

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png']);
    await page.getByLabel('Batch name').fill('ReNote Batch');
    await pickTargetCookbook(page, 'ReNote Cookbook');
    await page.getByRole('button', { name: 'Start import' }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);
    const items = await waitForBatchItemCount(batchId, 1);
    const item = items[0]!;

    // First pass: read as a recipe.
    await seedOcrFixture({
      storagePath: item.storage_path,
      provider: 'gemini',
      kind: 'recipe',
      draft: {
        title: 'Misread As A Recipe',
        instructions: [{ stepNumber: 1, text: 'Mix.' }],
      },
    });
    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 1, 45_000);

    await page.goto(`/import/${batchId}/items/${item.id}`);
    await expect(page.getByText('Misread As A Recipe')).toBeVisible({ timeout: 15_000 });

    // Swap the fixture to a note and mark the page as notes (re-OCRs server-side).
    await seedOcrFixture({
      storagePath: item.storage_path,
      provider: 'gemini',
      kind: 'notes',
      upsert: true,
      note: { title: 'Chapter Intro', body: 'On the philosophy of bread.' },
    });
    await page.getByText('This is an intro / notes page').click();
    await waitForItemKind(item.id, 'NOTES');
    // The re-OCR cleared the stale recipe draft.
    await expect(page.getByText('Misread As A Recipe')).toHaveCount(0);

    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 1, 45_000);

    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'ReNote Cookbook' }).click();
    await page.reload();
    await waitForSynced(page);
    // Exactly one note, with the new content; the recipe never landed.
    await expect(page.getByText('Chapter Intro')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('On the philosophy of bread.')).toBeVisible();
    await expect(page.getByText('Chapter Intro')).toHaveCount(1);
    await expect(page.getByText('Misread As A Recipe')).toHaveCount(0);
  });
});
