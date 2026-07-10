import { adminGet } from './support/admin.js';
import { expect, test, waitForSynced } from './support/fixtures.js';
import {
  configureOcrKey,
  type FakeRecipeDraft,
  listBatchItems,
  listItemAttempts,
  pumpItemStatuses,
  seedOcrFixture,
  triggerWorker,
  uploadTestImages,
  waitForBatchItemCount,
  waitForBatchStatus,
  waitForItemStatuses,
} from './support/imports.js';

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

async function createCookbook(page: import('@playwright/test').Page, title: string): Promise<void> {
  await page.goto('/library');
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

    // Drain OCR robustly — re-kick until all 5 reach OCR_DONE. A single kick can
    // race the queue (the page's own ocr_kick or a concurrent test) and claim 0.
    await pumpItemStatuses(batchId, (c) => c.ocrDone === 5, 45_000);
    await waitForBatchStatus(page, batchId, { done: 5, failed: 0, parked: 0 });

    await expect(page.getByText(/Needs review/).first()).toBeVisible({ timeout: 15_000 });

    const firstCard = page.locator('main ul li a').first();
    await firstCard.click();
    await page.waitForURL(/\/import\/[0-9a-f-]+\/items\/[0-9a-f-]+$/);
    await expect(page.getByRole('link', { name: /Bulk Batch One/ })).toBeVisible({
      timeout: 15_000,
    });

    // Two "Save as recipe" buttons render: one in the sticky top-nav,
    // one in the body. Both fire the same handler; .first() targets the
    // sticky one deterministically.
    await page.getByRole('button', { name: 'Save as recipe' }).first().click();
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

  test('a saved recipe stays on its import item page, editable and deletable', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await createCookbook(page, 'Saved Page Cookbook');

    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png']);
    await page.getByLabel('Batch name').fill('Saved Page Batch');
    await pickTargetCookbook(page, 'Saved Page Cookbook');
    await page.getByRole('button', { name: 'Start import' }).click();

    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    const batchId = await batchIdFromUrl(page);

    const items = await waitForBatchItemCount(batchId, 1);
    const itemId = items[0]!.id;
    await seedOcrFixture({
      storagePath: items[0]!.storage_path,
      kind: 'recipe',
      draft: recipeDraft('Saved Page Recipe', 'flour'),
    });
    await pumpItemStatuses(batchId, (c) => c.ocrDone === 1, 45_000);

    // Save the OCR draft as a recipe. This consumes the draft into
    // createdRecipeIds — the crux of the feature: the recipe must remain
    // visible on the item page afterwards.
    await page.goto(`/import/${batchId}/items/${itemId}`);
    await page.getByRole('button', { name: 'Save as recipe' }).first().click();
    // The only item is now REVIEWED, so save auto-advances to the batch
    // board. Anchor on that URL (no trailing /items/) so we actually wait
    // for the save to commit before revisiting the item page.
    await page.waitForURL(new RegExp(`/import/${batchId}$`));
    await waitForSynced(page);

    // Revisit the item page: the saved recipe shows under "Recipes saved
    // from this page", with a view link, an Edit link to the full editor,
    // and a Delete button.
    await page.goto(`/import/${batchId}/items/${itemId}`);
    const savedList = page.getByTestId('saved-recipes');
    await expect(savedList).toBeVisible({ timeout: 15_000 });
    await expect(savedList.getByRole('link', { name: 'Saved Page Recipe' })).toBeVisible();
    await expect(savedList.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      /\/collections\/[0-9a-f-]+\/recipes\/[0-9a-f-]+\/edit$/,
    );

    // Delete permanently removes it from the library and drops it from the
    // page's list (accept the confirm()).
    page.once('dialog', (d) => void d.accept());
    await savedList.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('saved-recipes')).toHaveCount(0, { timeout: 15_000 });
    await waitForSynced(page);

    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Saved Page Cookbook' }).click();
    await expect(page.getByText('Saved Page Recipe')).toHaveCount(0);
  });

  test('inline "create cookbook" from the picker captures an ISBN and selects it', async ({
    authedPage: page,
    user,
  }) => {
    // The shared CollectionPicker gives every import picker a full
    // create-cookbook flow (with ISBN), replacing the old title-only create.
    await configureOcrKey(page, 'gemini');
    await page.goto('/import/new');
    await uploadTestImages(page, ['page1.png']);

    // Open the target-cookbook picker → "Create new cookbook…".
    await page.getByLabel('Target cookbook').click();
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await listbox.getByRole('option', { name: /Create new cookbook/ }).click();

    // Fill the BookMetadataFields form (title first so an ISBN autofill can't
    // clobber it) and create. The metadata fields nest inside the outer
    // "Target cookbook" <label>, so target inputs by placeholder / label-span
    // sibling rather than getByLabel.
    const title = 'Isbn Picker Cookbook';
    const isbn = '9781566199094';
    await page.locator('span:text-is("Title") + input').fill(title);
    await page.getByPlaceholder('ISBN-10 or ISBN-13 (optional)').fill(isbn);
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // The new cookbook becomes the selected target (shown in the picker button)…
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });

    // …and persisted as a PUBLISHED_BOOK carrying the ISBN. The write is
    // local-first (outbox push in the background), so poll the server rather
    // than asserting the instant the picker updates.
    let cols: { id: string; isbn: string | null; source_type: string }[] = [];
    await expect
      .poll(
        async () => {
          cols = await adminGet<{ id: string; isbn: string | null; source_type: string }[]>(
            `/rest/v1/recipe_collections?owner_id=eq.${user.id}&title=eq.${encodeURIComponent(
              title,
            )}&select=id,isbn,source_type`,
          );
          return cols.length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    expect(cols[0]!.source_type).toBe('PUBLISHED_BOOK');
    expect(cols[0]!.isbn).toBe(isbn);
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

    await pumpItemStatuses(batchId, (c) => c.ocrDone === 3, 45_000);
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
    await waitForItemStatuses(batchId, (c) => c.needsFallback === 2 && c.ocrDone === 1, 45_000);

    await page.reload();
    await waitForSynced(page);
    await expect(page.getByText(/hit a copyright\/content-filter refusal/)).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Yes, use fallback' }).click();
    // Wait for applyRecitation to actually land server-side. The
    // recitation banner is shown only when recitation_policy === 'ASK';
    // once setRecitationPolicy lands and the local DB syncs, it goes
    // away. Without this, triggerWorker below could race against the
    // policy update and find no PENDING items to claim yet.
    await expect(page.getByText(/hit a copyright\/content-filter refusal/)).toHaveCount(0, {
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
