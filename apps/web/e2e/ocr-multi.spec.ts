import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './support/fixtures.js';
import { waitForSynced } from './support/fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures');
import {
  configureOcrKey,
  pumpWorker,
  seedOcrFixture,
} from './support/imports.js';

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

async function uploadAndOpenPicker(
  page: import('@playwright/test').Page,
  collectionTitle: string,
): Promise<void> {
  await page.goto('/library');
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(collectionTitle);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: collectionTitle })).toBeVisible();

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload image' }).click();
  const chooser = await fileChooserPromise;
  // Real PNG — prepareImage decodes via canvas and throws on a
  // stub-byte JPEG.
  await chooser.setFiles({
    name: 'spread.png',
    mimeType: 'image/png',
    buffer: readFileSync(resolve(FIXTURES_DIR, 'page1.png')),
  });

  // The page calls ocr_kick once the upload completes, but the test
  // env doesn't have the vault secret. Pump the worker until it claims
  // something — the outbox push that makes the row visible server-side
  // is asynchronous.
  await pumpWorker();

  const picker = page.getByTestId('ocr-recipe-picker');
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await expect(picker.getByText('Found 2 recipes')).toBeVisible();
}

test.describe('OCR multi-recipe review editor', () => {
  test.slow();

  test('two drafts arrive as tabs; promoting both lands two recipes and moves the item to REVIEWED', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await seedMultiRecipeFixture();
    await uploadAndOpenPicker(page, 'Multi-Recipe Photo');

    const picker = page.getByTestId('ocr-recipe-picker');
    await picker.getByText('Chewy Cookies').click();
    await page.waitForURL(/\/import\/[0-9a-f-]+\/items\/[0-9a-f-]+/);

    const tabs = page.getByTestId('draft-tabs');
    await expect(tabs.getByRole('tab', { name: 'Chewy Cookies' })).toBeVisible();
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
    await uploadAndOpenPicker(page, 'Discard-One Photo');

    const picker = page.getByTestId('ocr-recipe-picker');
    await picker.getByText('Chewy Cookies').click();
    await page.waitForURL(/\/import\/[0-9a-f-]+\/items\/[0-9a-f-]+/);

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
