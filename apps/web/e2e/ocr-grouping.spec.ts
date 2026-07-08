import { expect, test } from './support/fixtures.js';
import {
  configureOcrKey,
  installScanShim,
  listBatchItems,
  seedOcrFixture,
  triggerWorker,
  waitForItemKind,
  waitForItemStatuses,
} from './support/imports.js';

function batchIdFromUrl(page: import('@playwright/test').Page): string {
  return page.url().split('/import/')[1]!.split(/[/?#]/)[0]!;
}

test.describe('Scan → organize into recipes', () => {
  test.slow();

  test('capture-time chaining pre-merges pages into one multi-page recipe (extras round-trip)', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    // Page 2 continues page 1 (the camera's ⛓ chain toggle); page 3 stands alone.
    await installScanShim(page, [
      'page1.png',
      { name: 'page2.png', joinsPrevious: true },
      'page3.png',
    ]);

    await page.goto('/import/scan');
    await page.getByRole('button', { name: 'Scan pages' }).click();

    // Capture now lands on the organizer, not straight on the board.
    await page.waitForURL(/\/import\/[0-9a-f-]+\/group$/, { timeout: 30_000 });
    const batchId = batchIdFromUrl(page);

    // The chain marker pre-merged pages 1+2 → two recipes from three pages.
    const startBtn = page.getByRole('button', { name: /Start OCR on 2 recipes/ });
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/, { timeout: 30_000 });

    // Server truth: page 2 was absorbed (DISCARDED) and its storage path was
    // appended to page 1's extra_storage_paths — the exact round-trip the
    // dropped-column bug used to lose.
    await expect
      .poll(
        async () => (await listBatchItems(batchId)).filter((i) => i.status === 'DISCARDED').length,
        { timeout: 15_000 },
      )
      .toBe(1);
    const items = await listBatchItems(batchId);
    const leader = items.find((i) => i.extra_storage_paths.length === 1);
    expect(leader, 'a leader should carry exactly one continuation page').toBeTruthy();
    expect(leader!.status).not.toBe('DISCARDED');
    // Page 3 is a single-page recipe with no continuation pages.
    expect(
      items.filter((i) => i.status !== 'DISCARDED' && i.extra_storage_paths.length === 0),
    ).toHaveLength(1);
  });

  test('merging two pages on the organizer produces one two-page recipe', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await installScanShim(page, ['page1.png', 'page2.png']);

    await page.goto('/import/scan');
    await page.getByRole('button', { name: 'Scan pages' }).click();
    await page.waitForURL(/\/import\/[0-9a-f-]+\/group$/, { timeout: 30_000 });
    const batchId = batchIdFromUrl(page);

    // Two pages arrive as two separate recipes; merge them into one.
    await expect(page.getByRole('button', { name: /Start OCR on 2 recipes/ })).toBeVisible();
    await page.getByRole('button', { name: 'Merge with next recipe' }).first().click();
    await page.getByRole('button', { name: /Start OCR on 1 recipe/ }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/, { timeout: 30_000 });

    await expect
      .poll(
        async () => (await listBatchItems(batchId)).filter((i) => i.status === 'DISCARDED').length,
        { timeout: 15_000 },
      )
      .toBe(1);
    const leader = (await listBatchItems(batchId)).find((i) => i.extra_storage_paths.length === 1);
    expect(leader, 'the merged recipe should span two pages').toBeTruthy();
  });

  test('setting a recipe to Contents on the organizer tags it TOC', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await installScanShim(page, ['page1.png']);

    await page.goto('/import/scan');
    await page.getByRole('button', { name: 'Scan pages' }).click();
    await page.waitForURL(/\/import\/[0-9a-f-]+\/group$/, { timeout: 30_000 });
    const batchId = batchIdFromUrl(page);

    // Choose the "Contents" page type on the single recipe card.
    await page.getByRole('radio', { name: 'Table of contents page' }).click();
    await page.getByRole('button', { name: /Start OCR on 1 recipe/ }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/, { timeout: 30_000 });
    const item = (await listBatchItems(batchId))[0]!;
    // The organizer's page-type write reached the server as kind = TOC (no re-OCR).
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
