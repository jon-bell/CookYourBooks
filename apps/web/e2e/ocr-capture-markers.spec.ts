import { expect, test } from './support/fixtures.js';
import {
  configureOcrKey,
  installScanShim,
  seedOcrFixture,
  triggerWorker,
  waitForBatchItemCount,
  waitForItemKind,
  waitForItemStatuses,
} from './support/imports.js';

function batchIdFromUrl(page: import('@playwright/test').Page): string {
  return page.url().split('/import/')[1]!.split(/[/?#]/)[0]!;
}

test.describe('Capture-time page markers', () => {
  test.slow();

  test('a "continues on next page" shot folds into the previous page (3 shots → 2 items)', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    // Page 2 continues page 1; page 3 is its own recipe.
    await installScanShim(page, [
      'page1.png',
      { name: 'page2.png', joinsPrevious: true },
      'page3.png',
    ]);

    await page.goto('/import/scan');
    await page.getByRole('button', { name: 'Scan pages' }).click();
    await page.waitForURL(/\/import\/[0-9a-f-]+$/, { timeout: 30_000 });
    const batchId = batchIdFromUrl(page);

    // The middle shot merged into page 1, so only two import items exist.
    const items = await waitForBatchItemCount(batchId, 2);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.page_index)).toEqual([0, 1]);
  });

  test('a shot marked as a table of contents at capture is tagged TOC', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await installScanShim(page, [{ name: 'page1.png', kind: 'TOC' }]);

    await page.goto('/import/scan');
    await page.getByRole('button', { name: 'Scan pages' }).click();
    await page.waitForURL(/\/import\/[0-9a-f-]+$/, { timeout: 30_000 });
    const batchId = batchIdFromUrl(page);

    const items = await waitForBatchItemCount(batchId, 1);
    const item = items[0]!;
    // The capture-time marker reached the server as kind = TOC (no re-OCR).
    await waitForItemKind(item.id, 'TOC');

    // The worker reads it with the ToC prompt and completes.
    await seedOcrFixture({
      storagePath: item.storage_path,
      provider: 'gemini',
      kind: 'toc',
      entries: [{ title: 'Lemon Cake', pageNumber: 12 }],
    });
    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 1, 45_000);
  });
});
