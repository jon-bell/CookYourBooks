import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Shopping list', () => {
  test('aggregates quantities across selected recipes', async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Shopping Source',
      recipeTitle: 'Bread',
      servings: { amount: '1', description: 'loaf' },
      ingredients: [
        { kind: 'measured', amount: '3', unit: 'cup', name: 'flour' },
        { kind: 'vague', name: 'salt' },
      ],
      steps: ['Bake.'],
    });

    // Second recipe in the same collection with overlapping + distinct items.
    await page.getByRole('link', { name: 'Shopping Source' }).first().click();
    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Pizza');
    const firstRow = page.locator('section', { hasText: 'Ingredients' }).locator('ul > li').first();
    await firstRow.locator('input[placeholder=amount]').fill('2');
    await firstRow.locator('select').nth(1).selectOption('cup');
    await firstRow.locator('input[placeholder="ingredient name"]').fill('flour');
    await page.getByRole('button', { name: '+ Add ingredient' }).click();
    const second = page.locator('section', { hasText: 'Ingredients' }).locator('ul > li').nth(1);
    await second.locator('input[placeholder=amount]').fill('1');
    await second.locator('select').nth(1).selectOption('cup');
    await second.locator('input[placeholder="ingredient name"]').fill('tomato sauce');
    await page.locator('ol textarea').first().fill('Top and bake.');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Pizza' })).toBeVisible();

    await page.locator('header').getByRole('link', { name: 'Shopping', exact: true }).click();
    await page.getByRole('checkbox').nth(0).check();
    await page.getByRole('checkbox').nth(1).check();

    await expect(page.getByRole('heading', { name: 'Groceries' })).toBeVisible();
    // 3 + 2 = 5 cups flour, aggregated across two recipes.
    await expect(page.getByText(/5 cup.*flour/)).toBeVisible();
    await expect(page.getByText(/1 cup.*tomato sauce/)).toBeVisible();
    await expect(page.getByText(/2 recipes/)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'To taste' })).toBeVisible();
    await expect(
      page.locator('section', { hasText: 'To taste' }).getByText(/^salt$/),
    ).toBeVisible();
  });

  test('check marks persist across navigation (localStorage)', async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Persist Check',
      recipeTitle: 'Butter Only',
      ingredients: [{ kind: 'measured', amount: '1', unit: 'cup', name: 'butter' }],
      steps: ['melt'],
    });
    await page.locator('header').getByRole('link', { name: 'Shopping', exact: true }).click();
    await page.getByRole('checkbox').first().check();
    // Check the grocery item.
    await page
      .locator('section', { hasText: 'Groceries' })
      .getByRole('checkbox')
      .first()
      .check();

    await page.getByRole('link', { name: 'Library' }).click();
    await page.locator('header').getByRole('link', { name: 'Shopping', exact: true }).click();
    await page.getByRole('checkbox').first().check();
    await expect(
      page
        .locator('section', { hasText: 'Groceries' })
        .getByRole('checkbox')
        .first(),
    ).toBeChecked();
  });
});
