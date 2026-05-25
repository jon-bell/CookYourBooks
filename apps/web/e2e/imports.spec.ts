import { expect, test } from './support/fixtures.js';
import {
  configureOcrKey,
  listBatchItems,
  listItemAttempts,
  seedOcrFixture,
  triggerWorker,
  uploadTestImages,
  waitForBatchItemCount,
  waitForBatchStatus,
  waitForItemStatuses,
  type FakeRecipeDraft,
} from './support/imports.js';
import { waitForSynced } from './support/fixtures.js';

function recipeDraft(title: string, ingredient: string): FakeRecipeDraft {
  return {
    title,
    servings: { amount: 4 },
    ingredients: [
      {
        type: 'MEASURED',
        name: ingredient,
        quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
      },
      { type: 'VAGUE', name: 'salt' },
    ],
    instructions: [
      { stepNumber: 1, text: `Combine ${ingredient}.` },
      { stepNumber: 2, text: 'Bake until golden.' },
    ],
  };
}

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
  await page.goto('/');
  await waitForSynced(page);
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await waitForSynced(page);
}

/** Drives the CookbookCombobox on /import/new. Replaces native
 * `selectOption` — the trigger is a button that opens a listbox with
 * a search input. */
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

test.describe('bulk OCR imports', () => {
  test.slow();

  test('5 images flow through OCR and one promotes into the target cookbook', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await createCookbook(page, 'Bulk Bakery');

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png', 'page2.png', 'page3.png', 'page4.png', 'page5.png']);
    await page.getByLabel('Batch name').fill('Bulk Batch One');
    await pickTargetCookbook(page, 'Bulk Bakery');
    await page.getByRole('button', { name: 'Start import' }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);

    const items = await waitForBatchItemCount(batchId, 5);
    for (let i = 0; i < items.length; i += 1) {
      await seedOcrFixture({
        storagePath: items[i]!.storage_path,
        kind: 'recipe',
        draft: recipeDraft(`Imported Recipe ${i + 1}`, `ingredient-${i + 1}`),
      });
    }

    const summary = await triggerWorker(batchId);
    expect(summary.processed + summary.remaining).toBeGreaterThanOrEqual(5);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 5, 45_000);
    await waitForBatchStatus(page, batchId, { done: 5, failed: 0, parked: 0 });

    await expect(page.getByText(/Needs review/).first()).toBeVisible({ timeout: 15_000 });

    const firstCard = page.locator('main ul li a').first();
    await firstCard.click();
    await page.waitForURL(/\/import\/[0-9a-f-]+\/items\/[0-9a-f-]+$/);
    await expect(page.getByRole('link', { name: /Bulk Batch One/ })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Save as recipe' }).click();
    // Save auto-advances: if more reviewable items remain in the batch
    // the page navigates to the next one; only when the batch is fully
    // reviewed does it fall back to the batch board. Both URLs are
    // valid post-save targets.
    await page.waitForURL(new RegExp(`/import/${batchId}(?:$|/items/)`));
    await waitForSynced(page);

    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Bulk Bakery' }).click();
    await expect(page.getByText('Imported Recipe 1')).toBeVisible({ timeout: 10_000 });
  });

  test('a 3-page PDF splits into three ordered items and all reach OCR_DONE', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');

    await page.goto('/import/new');
    await uploadTestImages(page, ['three-pages.pdf']);
    await page.getByRole('button', { name: 'Start import' }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/, { timeout: 60_000 });
    const batchId = await batchIdFromUrl(page);

    const items = await waitForBatchItemCount(batchId, 3, 30_000);
    for (let i = 0; i < items.length; i += 1) {
      expect(items[i]!.page_index).toBe(i);
      await seedOcrFixture({
        storagePath: items[i]!.storage_path,
        kind: 'recipe',
        draft: recipeDraft(`PDF Page ${i + 1}`, `pdf-ingredient-${i + 1}`),
      });
    }

    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 3, 45_000);
    await waitForBatchStatus(page, batchId, { done: 3, failed: 0, parked: 0 });
  });

  test('RECITATION items park, then succeed via the fallback model', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await configureOcrKey(page, 'openai-compatible');
    await createCookbook(page, 'Fallback Cookbook');

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png', 'page2.png', 'page3.png']);
    await pickTargetCookbook(page, 'Fallback Cookbook');
    await page.getByLabel('Fallback provider (optional)').selectOption('openai-compatible');
    await page.getByLabel('Fallback model').fill('gpt-4o');
    await page.getByRole('button', { name: 'Start import' }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);

    const items = await waitForBatchItemCount(batchId, 3);

    // Attempt #1: every item hits gemini and the first two trip
    // recitation. The third succeeds outright so we know the worker
    // didn't accidentally pick gemini for everything.
    for (const it of items.slice(0, 2)) {
      await seedOcrFixture({
        storagePath: it.storage_path,
        provider: 'gemini',
        kind: 'recitation',
      });
    }
    await seedOcrFixture({
      storagePath: items[2]!.storage_path,
      provider: 'gemini',
      kind: 'recipe',
      draft: recipeDraft('Third Page', 'butter'),
    });

    // Attempt #2 (only for items[0] / items[1]): openai-compatible
    // returns a clean payload. The deliberate "FALLBACK-OK:" prefix in
    // the title lets us confirm the persisted recipe came from the
    // fallback fixture, not the original gemini one.
    await seedOcrFixture({
      storagePath: items[0]!.storage_path,
      provider: 'openai-compatible',
      kind: 'recipe',
      draft: recipeDraft('FALLBACK-OK: Recovered One', 'sugar'),
    });
    await seedOcrFixture({
      storagePath: items[1]!.storage_path,
      provider: 'openai-compatible',
      kind: 'recipe',
      draft: recipeDraft('FALLBACK-OK: Recovered Two', 'cocoa'),
    });

    await triggerWorker(batchId);
    await waitForItemStatuses(
      batchId,
      (c) => c.needsFallback === 2 && c.ocrDone === 1,
      45_000,
    );

    await page.reload();
    await waitForSynced(page);
    await expect(page.getByText(/hit copyright recitation/)).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Yes, use fallback' }).click();
    // Wait for applyRecitation to actually land server-side. The
    // recitation banner is shown only when recitation_policy === 'ASK';
    // once setRecitationPolicy lands and the local DB syncs, it goes
    // away. Without this, triggerWorker below could race against the
    // policy update and find no PENDING items to claim yet.
    await expect(page.getByText(/hit copyright recitation/)).toHaveCount(0, {
      timeout: 15_000,
    });
    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 3, 45_000);
    await waitForBatchStatus(page, batchId, { done: 3, failed: 0, parked: 0 });

    // Assert the provider actually switched on attempt #2 by reading
    // the persisted attempt history rather than trusting the on-page
    // status badge.
    const attempts = await listItemAttempts(items[0]!.id);
    expect(attempts.length).toBe(2);
    expect(attempts[0]!.provider).toBe('gemini');
    expect(attempts[0]!.error_kind).toBe('RECITATION');
    expect(attempts[1]!.provider).toBe('openai-compatible');
    expect(attempts[1]!.error_kind).toBe('OK');
  });

  test('worker progress survives a page reload', async ({ authedPage: page }) => {
    await configureOcrKey(page, 'gemini');

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png', 'page2.png', 'page3.png', 'page4.png']);
    await page.getByRole('button', { name: 'Start import' }).click();
    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);

    const items = await waitForBatchItemCount(batchId, 4);
    for (let i = 0; i < items.length; i += 1) {
      await seedOcrFixture({
        storagePath: items[i]!.storage_path,
        kind: 'recipe',
        draft: recipeDraft(`Slow Page ${i + 1}`, `ingredient-${i + 1}`),
        latencyMs: i === 0 ? 0 : 250,
      });
    }

    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone >= 1, 30_000);

    await page.reload();
    await waitForSynced(page);
    const rowsAfterReload = await listBatchItems(batchId);
    expect(rowsAfterReload.length).toBe(4);
    const doneAfterReload = rowsAfterReload.filter((r) => r.status === 'OCR_DONE').length;
    expect(doneAfterReload).toBeGreaterThanOrEqual(1);

    await waitForItemStatuses(batchId, (c) => c.ocrDone === 4, 60_000);
    await waitForBatchStatus(page, batchId, { done: 4, failed: 0, parked: 0 });
  });
});
