import { test, expect } from './support/fixtures.js';
import { waitForSynced } from './support/fixtures.js';

const ID = {
  flourA: '11111111-1111-1111-1111-111111111111',
  saltA: '22222222-2222-2222-2222-222222222222',
  stepA: '33333333-3333-3333-3333-333333333333',
  flourB: '44444444-4444-4444-4444-444444444444',
  stepB: '55555555-5555-5555-5555-555555555555',
} as const;

const FAKE_DRAFTS = [
  {
    title: 'Chewy Cookies',
    bookTitle: 'Weekend Baking',
    pageNumbers: [42],
    servings: { amount: 24, description: 'cookie' },
    description: 'The chewy one.',
    timeEstimate: '45 minutes',
    equipment: ['stand mixer'],
    ingredients: [
      {
        type: 'MEASURED',
        id: ID.flourA,
        name: 'flour',
        quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
      },
      { type: 'VAGUE', id: ID.saltA, name: 'salt', description: 'to taste' },
    ],
    instructions: [
      {
        id: ID.stepA,
        stepNumber: 1,
        text: 'Mix 2 cup flour with the salt.',
        ingredientRefs: [],
      },
    ],
    leftover: [],
  },
  {
    title: 'Crispy Cookies',
    bookTitle: 'Weekend Baking',
    pageNumbers: [43],
    servings: { amount: 18, description: 'cookie' },
    ingredients: [
      {
        type: 'MEASURED',
        id: ID.flourB,
        name: 'flour',
        quantity: { type: 'EXACT', amount: 1.5, unit: 'cup' },
      },
    ],
    instructions: [
      {
        id: ID.stepB,
        stepNumber: 1,
        text: 'Roll thin and bake.',
        ingredientRefs: [],
      },
    ],
    leftover: [],
  },
];

async function installShim(
  page: import('@playwright/test').Page,
  drafts: typeof FAKE_DRAFTS,
): Promise<void> {
  await page.addInitScript((draftsJson: string) => {
    const parsed = JSON.parse(draftsJson);
    window.__cybOcrShim = async () => parsed;
  }, JSON.stringify(drafts));
  await page.reload();
  await waitForSynced(page);
}

async function uploadAndOpenPicker(
  page: import('@playwright/test').Page,
  collectionTitle: string,
): Promise<void> {
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(collectionTitle);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: collectionTitle })).toBeVisible();

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload image' }).click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles({
    name: 'spread.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });

  const picker = page.getByTestId('ocr-recipe-picker');
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await expect(picker.getByText('Found 2 recipes')).toBeVisible();
}

test.describe('OCR multi-recipe review editor', () => {
  test('two drafts arrive as tabs; promoting both lands two recipes and moves the item to REVIEWED', async ({
    authedPage: page,
  }) => {
    await installShim(page, FAKE_DRAFTS);
    await uploadAndOpenPicker(page, 'Multi-Recipe Photo');

    const picker = page.getByTestId('ocr-recipe-picker');
    await picker.getByText('Chewy Cookies').click();
    await page.waitForURL(/\/import\/[0-9a-f-]+\/items\/[0-9a-f-]+/);

    const tabs = page.getByTestId('draft-tabs');
    await expect(tabs.getByRole('tab', { name: 'Chewy Cookies' })).toBeVisible();
    await expect(tabs.getByRole('tab', { name: 'Crispy Cookies' })).toBeVisible();

    await page.getByRole('button', { name: 'Save as recipe' }).click();
    // After saving the active draft, only the remaining one is left
    // on this item — the tab strip collapses entirely (it only renders
    // when drafts.length > 1).
    await expect(tabs).toHaveCount(0);

    await page.getByRole('button', { name: 'Save as recipe' }).click();
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
    await installShim(page, FAKE_DRAFTS);
    await uploadAndOpenPicker(page, 'Discard-One Photo');

    const picker = page.getByTestId('ocr-recipe-picker');
    await picker.getByText('Chewy Cookies').click();
    await page.waitForURL(/\/import\/[0-9a-f-]+\/items\/[0-9a-f-]+/);

    await page.getByRole('button', { name: 'Discard this draft' }).click();
    await expect(page.getByTestId('draft-tabs')).toHaveCount(0);

    await page.getByRole('button', { name: 'Save as recipe' }).click();
    await page.waitForURL(/\/import\/[0-9a-f-]+$/);
    await waitForSynced(page);

    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Discard-One Photo' }).click();
    await expect(page.getByText('Crispy Cookies')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Chewy Cookies')).toHaveCount(0);
  });
});
