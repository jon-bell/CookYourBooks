import { test, expect } from './support/fixtures.js';

// Canned draft the shim hands back. Covers EXACT/FRACTIONAL/VAGUE
// ingredients plus multiple instructions — enough to exercise every branch
// of the editor's seed-from-draft path.
const FAKE_DRAFT = {
  title: "Grandma's Lemon Bars",
  servings: { amount: 12 },
  ingredients: [
    {
      type: 'MEASURED',
      id: 'i1',
      name: 'flour',
      quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
    },
    {
      type: 'MEASURED',
      id: 'i2',
      name: 'powdered sugar',
      quantity: { type: 'FRACTIONAL', whole: 0, numerator: 1, denominator: 2, unit: 'cup' },
    },
    {
      type: 'MEASURED',
      id: 'i3',
      name: 'butter',
      preparation: 'softened',
      quantity: { type: 'EXACT', amount: 1, unit: 'cup' },
    },
    { type: 'VAGUE', id: 'i4', name: 'eggs' },
    { type: 'VAGUE', id: 'i5', name: 'salt' },
  ],
  instructions: [
    { id: 's1', stepNumber: 1, text: 'Press crust into the pan.', ingredientRefs: [] },
    { id: 's2', stepNumber: 2, text: 'Bake crust at 350F for 20 minutes.', ingredientRefs: [] },
    { id: 's3', stepNumber: 3, text: 'Whisk filling and pour over hot crust.', ingredientRefs: [] },
    { id: 's4', stepNumber: 4, text: 'Bake 25 more minutes, then cool.', ingredientRefs: [] },
  ],
  leftover: [],
};

test.describe('OCR import from photo', () => {
  test('reads a photo via the configured LLM and prefills the recipe editor', async ({
    authedPage: page,
  }) => {
    // Install a recognition shim for every page load so the real LLM call
    // never fires. `ocr.ts` looks for `window.__cybOcrShim` and short-
    // circuits when present. The addInitScript only applies to future
    // navigations, so reload after registering to pull it into the already-
    // loaded session.
    await page.addInitScript((draftJson: string) => {
      const draft = JSON.parse(draftJson);
      // Shim returns an array — the parser produces one draft per
      // recipe on the page, even if there's only one.
      window.__cybOcrShim = async () => [draft];
    }, JSON.stringify(FAKE_DRAFT));
    await page.reload();

    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Photo Imports');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Photo Imports' })).toBeVisible();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Take photo' }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: 'recipe.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });

    await page.waitForURL(/\/recipes\/new$/);
    await expect(page.locator('main input').first()).toHaveValue("Grandma's Lemon Bars");
    await expect(page.getByLabel('Servings')).toHaveValue('12');

    await expect(page.locator('input[placeholder="ingredient name"]')).toHaveCount(5);
    const names = page.locator('input[placeholder="ingredient name"]');
    await expect(names.nth(0)).toHaveValue('flour');
    await expect(names.nth(1)).toHaveValue('powdered sugar');
    await expect(names.nth(2)).toHaveValue('butter');
    await expect(names.nth(3)).toHaveValue('eggs');
    await expect(names.nth(4)).toHaveValue('salt');

    const steps = page.locator('ol textarea');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toHaveValue('Press crust into the pan.');
    await expect(steps.nth(3)).toHaveValue('Bake 25 more minutes, then cool.');
  });

  test('import button directs to Settings when no provider is configured', async ({
    authedPage: page,
  }) => {
    // No shim, and make sure no stale settings from a prior run are around.
    await page.evaluate(() => localStorage.removeItem('cookyourbooks.ocr.v1'));

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

    await expect(page.getByText(/OCR is not configured/)).toBeVisible();
    await page.getByRole('link', { name: /Open settings/ }).click();
    await page.waitForURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('Settings form persists provider + API key to localStorage', async ({
    authedPage: page,
  }) => {
    await page.goto('/settings');
    await page.getByLabel('API key').fill('sk-test-123');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText(/^Saved\.$/)).toBeVisible();

    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('cookyourbooks.ocr.v1') ?? 'null'),
    );
    expect(stored?.apiKey).toBe('sk-test-123');
    expect(stored?.provider).toBe('gemini');
  });

  test('shortcut `n` on a collection page opens the recipe editor', async ({
    authedPage: page,
  }) => {
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
