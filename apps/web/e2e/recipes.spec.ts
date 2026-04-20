import { test, expect, waitForSynced } from './support/fixtures.js';

async function seedCollection(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test.describe('Recipes — CRUD + editor', () => {
  test('creates a recipe with typed ingredients + instructions', async ({ authedPage: page }) => {
    await seedCollection(page, 'Bakes');
    await page.getByRole('link', { name: 'Add recipe' }).click();

    await page.locator('main input').first().fill('Pancakes');
    await page.getByLabel('Servings').fill('4');
    await page.getByLabel('Description (optional)').fill('pancakes');

    // First (default) ingredient row: switch unit to cup and fill flour.
    const firstRow = page.locator('ul > li').first();
    await firstRow.locator('input[placeholder=amount]').fill('2');
    await firstRow.locator('select').nth(1).selectOption('cup');
    await firstRow.locator('input[placeholder="ingredient name"]').fill('flour');

    // Add a vague ingredient too.
    await page.getByRole('button', { name: '+ Add ingredient' }).click();
    const secondRow = page.locator('ul > li').nth(1);
    await secondRow.locator('select').first().selectOption('VAGUE');
    await secondRow.locator('input[placeholder="ingredient name"]').fill('salt');

    // First instruction.
    await page.locator('ol textarea').first().fill('Whisk dry ingredients.');
    await page.getByRole('button', { name: '+ Add step' }).click();
    await page.locator('ol textarea').nth(1).fill('Cook on a hot griddle.');

    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Pancakes' })).toBeVisible();
    await expect(page.getByText('Serves 4 pancakes')).toBeVisible();
    await expect(page.getByText('2 cup flour')).toBeVisible();
    await expect(page.getByText(/^salt$/)).toBeVisible();
    await waitForSynced(page);
  });

  test('bulk-pastes ingredients from text and parses them', async ({ authedPage: page }) => {
    await seedCollection(page, 'Imported');
    await page.getByRole('link', { name: 'Add recipe' }).click();

    await page.locator('main input').first().fill('Quick Soup');

    await page.getByText('Paste ingredients from text').click();
    await page
      .locator('textarea')
      .filter({ hasText: '' })
      .first()
      .fill('2 cups water\n1 1/2 tsp salt\nolive oil to taste');
    await page.getByRole('button', { name: 'Parse and add' }).click();

    // The parser drops the empty default row and inserts the parsed rows.
    await expect(page.locator('input[placeholder="ingredient name"]')).toHaveCount(3);
    const nameInputs = page.locator('input[placeholder="ingredient name"]');
    await expect(nameInputs.nth(0)).toHaveValue('water');
    await expect(nameInputs.nth(1)).toHaveValue('salt');
    await expect(nameInputs.nth(2)).toHaveValue('olive oil');

    await page.locator('ol textarea').first().fill('Boil and eat.');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Quick Soup' })).toBeVisible();
  });

  test('edits a recipe title; change persists and syncs', async ({ authedPage: page }) => {
    await seedCollection(page, 'Classics');
    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Roast');
    await page.locator('input[placeholder="ingredient name"]').first().fill('meat');
    await page.locator('ol textarea').first().fill('Roast until done.');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Roast' })).toBeVisible();

    await page.getByRole('link', { name: 'Edit' }).click();
    await page.waitForURL(/\/edit$/);
    // Wait until the editor has rehydrated the existing recipe — the title
    // input starts life as the current value.
    const title = page.locator('main input').first();
    await expect(title).toHaveValue('Roast');
    await title.fill('Sunday Roast');
    await page.getByRole('button', { name: 'Save recipe' }).click();

    await expect(page.getByRole('heading', { name: 'Sunday Roast' })).toBeVisible();
    await waitForSynced(page);

    // Reload to prove it round-tripped through the local DB.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sunday Roast' })).toBeVisible();
  });

  test('deletes a recipe from the detail page', async ({ authedPage: page }) => {
    await seedCollection(page, 'To Prune');
    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Doomed Recipe');
    await page.locator('input[placeholder="ingredient name"]').first().fill('x');
    await page.locator('ol textarea').first().fill('x');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Doomed Recipe' })).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete' }).click();

    await expect(page).toHaveURL(/\/collections\//);
    await expect(page.getByText('Doomed Recipe')).toHaveCount(0);
  });
});
