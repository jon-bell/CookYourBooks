import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Cookbook recipe sort', () => {
  test('sorts by name independent of creation/manual order', async ({ authedPage: page }) => {
    // First recipe (created first → first in manual order).
    await createRecipeViaUi(page, {
      collectionTitle: 'Sortbook',
      recipeTitle: 'Zebra Cake',
      ingredients: [{ kind: 'vague', name: 'sugar' }],
      steps: ['Bake.'],
    });

    // Second recipe in the same collection, alphabetically first.
    await page.getByRole('link', { name: 'Sortbook' }).first().click();
    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Apple Pie');
    await page.locator('ol textarea').first().fill('Bake.');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Apple Pie' })).toBeVisible();

    // Open the cookbook from the Library.
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Sortbook' }).first().click();
    await expect(page.getByRole('heading', { name: 'Sortbook' })).toBeVisible();

    // Recipe rows are the links into /recipes/. Wait for both to render.
    const rows = page.locator('ul a[href*="/recipes/"]').filter({ hasText: /Zebra Cake|Apple Pie/ });
    await expect(rows).toHaveCount(2);
    const order = async () => {
      const texts = await rows.allInnerTexts();
      return {
        zebra: texts.findIndex((t) => t.includes('Zebra Cake')),
        apple: texts.findIndex((t) => t.includes('Apple Pie')),
      };
    };

    // Manual order = creation order: Zebra (first) before Apple.
    const manual = await order();
    expect(manual.zebra).toBeLessThan(manual.apple);

    // Switch to Name (A–Z): Apple now sorts before Zebra.
    await page.getByLabel('Sort').selectOption('name');
    await expect
      .poll(async () => (await order()).apple)
      .toBeLessThan((await order()).zebra);
  });
});
