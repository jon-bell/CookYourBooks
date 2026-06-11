import { expect, test, waitForSynced } from './support/fixtures.js';
import {
  configureOcrKey,
  seedOcrFixture,
  triggerWorker,
  uploadTestImages,
  waitForBatchItemCount,
  waitForItemIsToc,
  waitForItemStatuses,
} from './support/imports.js';

async function batchIdFromUrl(page: import('@playwright/test').Page): Promise<string> {
  const url = new URL(page.url());
  const m = url.pathname.match(/\/import\/([0-9a-f-]+)/);
  if (!m) throw new Error(`Not on a batch page: ${url.pathname}`);
  return m[1]!;
}

async function createCookbook(page: import('@playwright/test').Page, title: string): Promise<void> {
  await page.goto('/library');
  await waitForSynced(page);
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await waitForSynced(page);
}

/** Drive the CookbookCombobox on /import/new — a button that opens a
 *  searchable listbox, not a native select. */
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

test.describe('OCR table-of-contents review', () => {
  test.slow();

  test('extracts ToC entries, lets the user review them, and approves them into placeholders', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await createCookbook(page, 'ToC Cookbook');

    // Upload one page targeting the cookbook. It lands PENDING — we mark
    // it as a ToC page *before* OCR runs so the worker re-reads it with
    // the table-of-contents prompt (the PENDING→PENDING status flip the
    // toggle makes is a no-op server-side, but the is_toc flag pushes).
    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png']);
    await page.getByLabel('Batch name').fill('ToC Batch');
    await pickTargetCookbook(page, 'ToC Cookbook');
    await page.getByRole('button', { name: 'Start import' }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);
    const items = await waitForBatchItemCount(batchId, 1);
    const item = items[0]!;

    // Seed the fixture the worker will return for this page when read as
    // a table of contents. One entry deliberately has no page number to
    // prove that path survives.
    await seedOcrFixture({
      storagePath: item.storage_path,
      // Pin the provider so the path×provider fixture wins the worker's
      // mock-lookup probe order over any leftover ('*', gemini, '')
      // recipe fixture seeded by a sibling spec.
      provider: 'gemini',
      kind: 'toc',
      entries: [
        { title: 'Lemon Drizzle Cake', pageNumber: 42 },
        { title: 'Sourdough Loaf', pageNumber: 88 },
        { title: 'Weeknight Ragu' },
      ],
    });

    // Open the page and flag it as a Table of Contents.
    await page.goto(`/import/${batchId}/items/${item.id}`);
    await page.getByText('This is a Table of Contents page').click();
    await waitForSynced(page);
    // Confirm the flag reached the server before kicking the worker —
    // otherwise it reads the page as a recipe, not a table of contents.
    await waitForItemIsToc(item.id, true);

    // Run the worker; the ToC item finishes OCR with its entries written.
    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 1, 45_000);

    // Pull the entries down and confirm the review panel renders them.
    await page.reload();
    await waitForSynced(page);
    const panel = page.getByTestId('toc-review-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const titleBoxes = panel.getByRole('textbox', { name: 'Entry title' });
    await expect(titleBoxes).toHaveCount(3);
    const titleValues = await titleBoxes.evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement).value),
    );
    expect([...titleValues].sort()).toEqual([
      'Lemon Drizzle Cake',
      'Sourdough Loaf',
      'Weeknight Ragu',
    ]);
    const pageValues = await panel
      .getByRole('textbox', { name: 'Page number' })
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(pageValues).toContain('42');
    expect(pageValues).toContain('88');
    await expect(panel.getByText('3 of 3 selected')).toBeVisible();

    // Edit one entry to prove the review is editable, then approve.
    await titleBoxes.nth(titleValues.indexOf('Weeknight Ragu')).fill('Sunday Ragu');
    await panel.getByRole('button', { name: /Approve & create 3 placeholders/ }).click();

    // Approve closes the item out and bounces back to the batch board.
    await page.waitForURL(new RegExp(`/import/${batchId}$`));
    await waitForSynced(page);

    // The placeholders now live in the cookbook.
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'ToC Cookbook' }).click();
    await expect(page.getByText('Lemon Drizzle Cake')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Sourdough Loaf')).toBeVisible();
    await expect(page.getByText('Sunday Ragu')).toBeVisible();
    // The edited title replaced the OCR original, not added alongside it.
    await expect(page.getByText('Weeknight Ragu')).toHaveCount(0);
  });

  test("a page already OCR'd as a recipe can be re-read as a table of contents", async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await createCookbook(page, 'ReOCR Cookbook');

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png']);
    await page.getByLabel('Batch name').fill('ReOCR Batch');
    await pickTargetCookbook(page, 'ReOCR Cookbook');
    await page.getByRole('button', { name: 'Start import' }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);
    const items = await waitForBatchItemCount(batchId, 1);
    const item = items[0]!;

    // First pass: the page is read as a (single) recipe and lands OCR_DONE.
    await seedOcrFixture({
      storagePath: item.storage_path,
      provider: 'gemini',
      kind: 'recipe',
      draft: {
        title: 'Misread As A Recipe',
        servings: { amount: 4 },
        ingredients: [{ type: 'VAGUE', name: 'salt' }],
        instructions: [{ stepNumber: 1, text: 'Mix.' }],
      },
    });
    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 1, 45_000);

    await page.goto(`/import/${batchId}/items/${item.id}`);
    // It came back as a recipe draft — no ToC panel yet.
    await expect(page.getByText('Misread As A Recipe')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('toc-review-panel')).toHaveCount(0);

    // Swap the fixture so the re-read returns a table of contents, then
    // flag the page as a ToC. Toggling re-runs OCR server-side.
    await seedOcrFixture({
      storagePath: item.storage_path,
      provider: 'gemini',
      kind: 'toc',
      upsert: true,
      entries: [
        { title: 'Roast Chicken', pageNumber: 10 },
        { title: 'Pan Gravy', pageNumber: 11 },
      ],
    });

    await page.getByText('This is a Table of Contents page').click();
    await waitForItemIsToc(item.id, true);
    // The re-OCR cleared the old recipe draft.
    await expect(page.getByText('Misread As A Recipe')).toHaveCount(0);

    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 1, 45_000);

    await page.reload();
    await waitForSynced(page);
    const panel = page.getByTestId('toc-review-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const titles = await panel
      .getByRole('textbox', { name: 'Entry title' })
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect([...titles].sort()).toEqual(['Pan Gravy', 'Roast Chicken']);

    await panel.getByRole('button', { name: /Approve & create 2 placeholders/ }).click();
    await page.waitForURL(new RegExp(`/import/${batchId}$`));
    await waitForSynced(page);

    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'ReOCR Cookbook' }).click();
    await expect(page.getByText('Roast Chicken')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Pan Gravy')).toBeVisible();
    // The mistaken recipe never made it into the cookbook.
    await expect(page.getByText('Misread As A Recipe')).toHaveCount(0);
  });

  test('bulk "Mark as ToC" re-OCRs the selected pages', async ({ authedPage: page }) => {
    await configureOcrKey(page, 'gemini');

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png', 'page2.png']);
    await page.getByLabel('Batch name').fill('Bulk ToC Batch');
    await page.getByRole('button', { name: 'Start import' }).click();
    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);
    const items = await waitForBatchItemCount(batchId, 2);

    // First pass: both read as recipes.
    for (const it of items) {
      await seedOcrFixture({
        storagePath: it.storage_path,
        provider: 'gemini',
        kind: 'recipe',
        draft: { title: 'Recipe Mistake', instructions: [{ stepNumber: 1, text: 'Mix.' }] },
      });
    }
    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 2, 45_000);

    // Swap both fixtures to ToC, then bulk-select both pages and mark as ToC.
    await seedOcrFixture({
      storagePath: items[0]!.storage_path,
      provider: 'gemini',
      kind: 'toc',
      upsert: true,
      entries: [{ title: 'Alpha Cake', pageNumber: 3 }],
    });
    await seedOcrFixture({
      storagePath: items[1]!.storage_path,
      provider: 'gemini',
      kind: 'toc',
      upsert: true,
      entries: [{ title: 'Beta Bread', pageNumber: 7 }],
    });

    await page.reload();
    await waitForSynced(page);
    await page.getByRole('checkbox', { name: 'Select page 1' }).check();
    await page.getByRole('checkbox', { name: 'Select page 2' }).check();
    await page.getByRole('button', { name: 'Mark as ToC' }).click();

    // Both flags must reach the server (the whole point — the old bulk
    // path dropped the PENDING flip and never re-OCR'd).
    await waitForItemIsToc(items[0]!.id, true);
    await waitForItemIsToc(items[1]!.id, true);

    await triggerWorker(batchId);
    await waitForItemStatuses(batchId, (c) => c.ocrDone === 2, 45_000);

    // Each page now yields its ToC entry in the review panel.
    await page.goto(`/import/${batchId}/items/${items[0]!.id}`);
    await page.reload();
    await waitForSynced(page);
    const panel = page.getByTestId('toc-review-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const titles = await panel
      .getByRole('textbox', { name: 'Entry title' })
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(titles).toContain('Alpha Cake');
  });
});
