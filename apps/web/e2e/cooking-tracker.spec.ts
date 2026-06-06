import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';
import { addDaysISO, todayISO } from '../src/cooking/dateGrid.js';

async function makeRecipe(page: import('@playwright/test').Page, recipeTitle: string) {
  await createRecipeViaUi(page, {
    collectionTitle: `Cooking ${recipeTitle}`,
    recipeTitle,
    servings: { amount: '4', description: 'servings' },
    ingredients: [
      { kind: 'measured', amount: '2', unit: 'cup', name: 'flour' },
      { kind: 'vague', name: 'salt' },
    ],
    steps: ['Mix everything.', 'Bake until done.'],
  });
}

test.describe('Cooking tracker', () => {
  test('logs "I made this" with notes + an ingredient swap and shows it in history', async ({
    authedPage: page,
  }) => {
    await makeRecipe(page, 'Banana Bread');

    await page.getByTestId('i-made-this').click();
    await page.getByTestId('cook-notes').fill('Came out great.');

    // Record a structured ingredient swap.
    await page.getByText('Record what I changed (optional)').click();
    await page.getByRole('button', { name: '+ Add change' }).click();
    await page.getByLabel('Replacement').fill('almond flour');

    await page.getByTestId('cook-submit').click();

    const history = page.getByTestId('cooking-history');
    await expect(history.getByText('Came out great.')).toBeVisible();
    await expect(history.getByText('Swapped flour → almond flour')).toBeVisible();
    await expect(history.getByRole('heading', { name: /History \(1\)/ })).toBeVisible();
  });

  test('schedules a future cook, then marks it cooked', async ({ authedPage: page }) => {
    await makeRecipe(page, 'Roast Chicken');

    await page.getByTestId('schedule-cook').click();
    await page.getByTestId('cook-date').fill(addDaysISO(todayISO(), 5));
    await page.getByTestId('cook-submit').click();

    const history = page.getByTestId('cooking-history');
    await expect(history.getByRole('heading', { name: /Upcoming \(1\)/ })).toBeVisible();

    await page.getByTestId('mark-cooked').click();
    await expect(history.getByRole('heading', { name: /History \(1\)/ })).toBeVisible();
    await expect(history.getByRole('heading', { name: /Upcoming/ })).toHaveCount(0);
  });

  test('deletes a logged cook', async ({ authedPage: page }) => {
    await makeRecipe(page, 'Pancakes');
    await page.getByTestId('i-made-this').click();
    await page.getByTestId('cook-notes').fill('Sunday breakfast.');
    await page.getByTestId('cook-submit').click();

    const history = page.getByTestId('cooking-history');
    await expect(history.getByText('Sunday breakfast.')).toBeVisible();
    await page.getByTestId('delete-cook').click();
    await expect(history.getByText('No cooks logged yet.', { exact: false })).toBeVisible();
  });

  test('shows cooks on the calendar and lists them for the selected day', async ({
    authedPage: page,
  }) => {
    await makeRecipe(page, 'Lasagna');
    await page.getByTestId('i-made-this').click();
    await page.getByTestId('cook-submit').click();
    await expect(page.getByTestId('cooking-history').getByText(/History \(1\)/)).toBeVisible();

    await page.locator('header').getByRole('link', { name: 'Cooking', exact: true }).click();
    // Today is selected by default; the day detail lists today's entry.
    const detail = page.getByTestId('calendar-day-detail');
    await expect(detail.getByRole('link', { name: 'Lasagna' })).toBeVisible();
    await expect(detail.getByText('Made')).toBeVisible();
  });

  test('preserves cooked history after the recipe is deleted', async ({ authedPage: page }) => {
    await makeRecipe(page, 'Doomed Stew');
    await page.getByTestId('i-made-this').click();
    await page.getByTestId('cook-notes').fill('Last time I make this.');
    await page.getByTestId('cook-submit').click();
    await expect(page.getByTestId('cooking-history').getByText(/History \(1\)/)).toBeVisible();

    // Delete the recipe (toolbar Delete is first in DOM order; the cook
    // entry also has a "Delete").
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click();

    // The cooked entry survives on the calendar via its snapshot (title
    // renders, but there's no link back to the now-deleted recipe).
    await page.goto('/cooking');
    const detail = page.getByTestId('calendar-day-detail');
    await expect(detail.getByText('Doomed Stew')).toBeVisible();
    await expect(detail.getByRole('link', { name: 'Doomed Stew' })).toHaveCount(0);
  });
});
