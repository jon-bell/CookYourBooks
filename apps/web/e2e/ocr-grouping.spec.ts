import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { expect, signIn, test } from './support/fixtures.js';
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

/**
 * Seed an already-OCR'd ("ocr-first") batch with `pageCount` standalone
 * OCR_DONE items directly via the service role — the shape the organizer's
 * reorganize mode operates on. Seeded before signIn so the login pull mirrors
 * it into local cr-sqlite (same owned-rows-before-login pattern the dark-mode
 * + covers specs use). Returns item ids in page order.
 */
async function seedOcrDoneBatch(
  userId: string,
  batchName: string,
  pageCount: number,
): Promise<{ batchId: string; itemIds: string[] }> {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  const batchResp = await fetch(`${SUPABASE_URL}/rest/v1/import_batches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      owner_id: userId,
      name: batchName,
      source_kind: 'IMAGES',
      default_model: 'gemini-2.5-flash',
      default_provider: 'gemini',
      total_items: pageCount,
    }),
  });
  if (!batchResp.ok) {
    throw new Error(`seed batch failed: ${batchResp.status} ${await batchResp.text()}`);
  }
  const [batch] = (await batchResp.json()) as { id: string }[];
  const batchId = batch!.id;

  const rows = Array.from({ length: pageCount }, (_, i) => ({
    batch_id: batchId,
    owner_id: userId,
    page_index: i,
    storage_path: `${userId}/${batchId}/page-${i}.png`,
    status: 'OCR_DONE',
  }));
  const itemResp = await fetch(`${SUPABASE_URL}/rest/v1/import_items`, {
    method: 'POST',
    headers,
    body: JSON.stringify(rows),
  });
  if (!itemResp.ok) {
    throw new Error(`seed items failed: ${itemResp.status} ${await itemResp.text()}`);
  }
  const created = (await itemResp.json()) as { id: string; page_index: number }[];
  created.sort((a, b) => a.page_index - b.page_index);
  return { batchId, itemIds: created.map((r) => r.id) };
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

  test("reorganize an already-OCR'd batch: merging two pages re-OCRs them into one", async ({
    page,
    user,
  }) => {
    // The reorganize confirm asks "Re-organize this scanned batch?" via
    // window.confirm — auto-accept it.
    page.on('dialog', (d) => void d.accept());

    const { batchId } = await seedOcrDoneBatch(user.id, 'Reorganize Batch', 3);

    await signIn(page, user);
    await page.goto(`/import/${batchId}/group`);

    // Reorganize mode renders the FULL organizer over the OCR'd pages — NOT the
    // "Nothing to organize" empty state. Three standalone recipes from 3 pages.
    await expect(page.getByRole('heading', { name: 'Organize into recipes' })).toBeVisible({
      timeout: 20_000,
    });
    const dividers = page.getByRole('button', { name: 'Merge with next recipe' });
    await expect(dividers).toHaveCount(2);
    // No changes yet → the confirm button is a plain "Done".
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();

    // Merge pages 1 + 2 into one two-page recipe.
    await dividers.first().click();
    const applyBtn = page.getByRole('button', { name: /Apply & re-OCR 2 pages/ });
    await expect(applyBtn).toBeVisible();
    await applyBtn.click();

    // Lands back on the batch board once the merge + re-OCR arm is applied.
    await page.waitForURL(new RegExp(`/import/${batchId}$`), { timeout: 30_000 });

    // Server truth: one page absorbed (DISCARDED), the primary reset to PENDING
    // for a fresh OCR pass carrying the continuation page in its extras, and the
    // untouched third page still OCR_DONE.
    await expect
      .poll(
        async () => (await listBatchItems(batchId)).filter((i) => i.status === 'DISCARDED').length,
        { timeout: 15_000 },
      )
      .toBe(1);
    const rows = await listBatchItems(batchId);
    const leader = rows.find((i) => i.extra_storage_paths.length === 1);
    expect(leader, 'the merged recipe should span two pages').toBeTruthy();
    expect(leader!.status).toBe('PENDING');
    expect(rows.filter((i) => i.status === 'OCR_DONE')).toHaveLength(1);
  });
});
