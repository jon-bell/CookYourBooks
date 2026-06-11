import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './support/fixtures.js';
import { configureOcrKey, pumpWorker, seedOcrFixture } from './support/imports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures');

const FAKE_DRAFT = {
  title: "Grandma's Lemon Bars",
  servings: { amount: 12 },
  ingredients: [
    {
      type: 'MEASURED' as const,
      name: 'flour',
      quantity: { type: 'EXACT' as const, amount: 2, unit: 'cup' },
    },
    {
      type: 'MEASURED' as const,
      name: 'powdered sugar',
      quantity: {
        type: 'FRACTIONAL' as const,
        whole: 0,
        numerator: 1,
        denominator: 2,
        unit: 'cup',
      },
    },
    {
      type: 'MEASURED' as const,
      name: 'butter',
      quantity: { type: 'EXACT' as const, amount: 1, unit: 'cup' },
    },
    { type: 'VAGUE' as const, name: 'eggs' },
    { type: 'VAGUE' as const, name: 'salt' },
  ],
  instructions: [
    { stepNumber: 1, text: 'Press crust into the pan.' },
    { stepNumber: 2, text: 'Bake crust at 350F for 20 minutes.' },
    { stepNumber: 3, text: 'Whisk filling and pour over hot crust.' },
    { stepNumber: 4, text: 'Bake 25 more minutes, then cool.' },
  ],
};

test.describe('OCR import from photo', () => {
  test.slow();

  test('reads a photo via the configured LLM and prefills the recipe editor', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    // Wildcard path — the page mints a random storage_path; the worker's
    // `(*, gemini, '')` probe matches whatever lands.
    await seedOcrFixture({
      storagePath: '*',
      provider: 'gemini',
      kind: 'recipe',
      upsert: true,
      draft: FAKE_DRAFT,
    });

    await page.goto('/library');
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Photo Imports');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Photo Imports' })).toBeVisible();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Take photo' }).click();
    const chooser = await fileChooserPromise;
    // Use a real PNG — `prepareImage` decodes the file via canvas and
    // throws on a stub 4-byte JPEG.
    await chooser.setFiles({
      name: 'recipe.png',
      mimeType: 'image/png',
      buffer: readFileSync(resolve(FIXTURES_DIR, 'page1.png')),
    });

    // The page calls ocr_kick once the upload completes, but the test
    // env doesn't have the vault secret. Pump the worker manually so the
    // batch's only item gets processed.
    await pumpWorker();

    await page.waitForURL(/\/import\/[0-9a-f-]+\/items\/[0-9a-f-]+/, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: "Grandma's Lemon Bars" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'powdered sugar', exact: true })).toBeVisible();
  });

  test('import button directs to Settings when no OCR key is configured', async ({
    authedPage: page,
  }) => {
    // Don't configure any OCR key. The page's listOcrKeys call returns
    // empty and the click surfaces the inline "OCR not configured"
    // error.
    await page.goto('/library');
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Needs Setup');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Needs Setup' })).toBeVisible();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Take photo' }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: 'dummy.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });

    await expect(page.getByText(/OCR not configured/)).toBeVisible();
    await page.getByRole('link', { name: /Open settings/ }).click();
    await page.waitForURL(/\/settings\/llm$/);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('Settings form persists default model + prompt server-side', async ({
    authedPage: page,
  }) => {
    await page.goto('/settings/llm');
    await page.getByLabel('Default model').fill('gemini-2.5-flash');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText(/^Saved\.$/)).toBeVisible();

    // Reload and confirm the change came back from user_ocr_prefs.
    await page.reload();
    await expect(page.getByLabel('Default model')).toHaveValue('gemini-2.5-flash');
  });

  test('shortcut `n` on a collection page opens the recipe editor', async ({
    authedPage: page,
  }) => {
    await page.goto('/library');
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Shortcut Land');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Shortcut Land' })).toBeVisible();

    await page.keyboard.press('n');
    await page.waitForURL(/\/recipes\/new$/);
    await expect(page.getByRole('heading', { name: 'New recipe' })).toBeVisible();
  });

  test('shortcut `?` toggles the keyboard help dialog', async ({ authedPage: page }) => {
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/ })).toHaveCount(0);
  });
});
