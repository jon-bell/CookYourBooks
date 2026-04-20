import { test, expect, waitForSynced } from './support/fixtures.js';

async function seedCollection(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function seedRecipe(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('link', { name: 'Add recipe' }).click();
  await page.locator('main input').first().fill(title);
  await page.locator('input[placeholder="ingredient name"]').first().fill('flour');
  await page.locator('input[placeholder=amount]').first().fill('2');
  await page.locator('ol textarea').first().fill('Mix and bake.');
  await page.getByRole('button', { name: 'Save recipe' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test.describe('Recipe adaptations', () => {
  test('adapt → tweak notes → lineage is visible on both ends', async ({
    authedPage: page,
  }) => {
    await seedCollection(page, 'Bakery');
    await seedRecipe(page, 'Base Loaf');

    // Fork it. The Adapt button lands us on the editor for the new recipe,
    // with a pre-filled title the user can refine before saving.
    await page.getByRole('button', { name: 'Adapt' }).click();
    await page.waitForURL(/\/edit$/);

    const title = page.locator('main input').first();
    await expect(title).toHaveValue('Base Loaf (adaptation)');
    await title.fill('Sourdough Variant');

    // Tweak one ingredient so the adaptation diverges from the base.
    await page.locator('input[placeholder=amount]').first().fill('3');

    // Jot a note about what changed.
    await page.getByLabel('Notes').fill('More flour, longer ferment.');

    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Sourdough Variant' })).toBeVisible();

    // The adaptation's detail page shows the parent pill + the notes block.
    await expect(page.getByText(/Adapted from/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Base Loaf' })).toBeVisible();
    await expect(page.getByText('More flour, longer ferment.')).toBeVisible();

    // Follow the parent link; the base now shows the adaptation under its
    // "Adaptations" section.
    await page.getByRole('link', { name: 'Base Loaf' }).click();
    await expect(page.getByRole('heading', { name: 'Base Loaf' })).toBeVisible();
    const adaptations = page.getByRole('heading', { name: /Adaptations \(1\)/ });
    await expect(adaptations).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sourdough Variant' })).toBeVisible();

    // Round-trip through the sync layer to confirm the parent pointer and
    // notes persist server-side.
    await waitForSynced(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: /Adaptations \(1\)/ })).toBeVisible();
  });
});
