import { expect, test } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Search', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    // The semantic search path lazy-downloads ~30 MB of model weights
    // from a CDN on first /search visit. Disable it in tests via the
    // shim hook so the substring fallback is exercised deterministically
    // — the real-model semantic path is covered in semantic.spec.ts.
    await page.addInitScript(() => {
      (window as unknown as { __cybDisableEmbedder?: boolean }).__cybDisableEmbedder = true;
    });
    await createRecipeViaUi(page, {
      collectionTitle: 'Dinners',
      recipeTitle: 'Chicken Soup',
      ingredients: [
        { kind: 'measured', amount: '1', unit: 'cup', name: 'stock' },
        { kind: 'vague', name: 'parsley' },
      ],
      steps: ['Simmer.'],
    });
    // Add a second, unrelated recipe to prove search actually filters.
    await page.getByRole('link', { name: 'Dinners' }).first().click();
    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Fruit Salad');
    const row = page.locator('section', { hasText: 'Ingredients' }).locator('ul > li').first();
    await row.locator('input[placeholder=amount]').fill('2');
    await row.locator('select').nth(1).selectOption('cup');
    await row.locator('input[placeholder="ingredient name"]').fill('strawberries');
    await page.locator('ol textarea').first().fill('Mix.');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    // Wait for the save to land before the test body starts.
    await expect(page.getByRole('heading', { name: 'Fruit Salad' })).toBeVisible();
  });

  async function openSearch(page: import('@playwright/test').Page) {
    await page.locator('header').getByRole('link', { name: 'Search', exact: true }).click();
    await page.waitForURL(/\/search$/);
  }

  test('matches on recipe title (case insensitive)', async ({ authedPage: page }) => {
    await openSearch(page);
    await page.getByPlaceholder(/Search by recipe/).fill('CHICKEN');
    // Debounce is 250ms; account for that plus the SQLite round-trip.
    await expect(page.getByText('Chicken Soup')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Fruit Salad')).toHaveCount(0);
  });

  test('matches on an ingredient name', async ({ authedPage: page }) => {
    await openSearch(page);
    await page.getByPlaceholder(/Search by recipe/).fill('parsley');
    await expect(page.getByText('Chicken Soup')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Fruit Salad')).toHaveCount(0);
  });

  test('empty query shows hint; unknown query shows zero results', async ({ authedPage: page }) => {
    await openSearch(page);
    // Empty input renders the "type to search" hint, not a counter.
    await expect(page.getByText(/Type to search/)).toBeVisible();

    await page.getByPlaceholder(/Search by recipe/).fill('anchovy');
    await expect(page.getByText(/^0 results$/)).toBeVisible({ timeout: 5000 });
  });
});
