import { addDaysISO, todayISO } from '../src/cooking/dateGrid.js';
import { expect, test } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Shop for scheduled cooks', () => {
  test('adds recipes scheduled in a date range to the shopping list', async ({
    authedPage: page,
  }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Schedule Shop',
      recipeTitle: 'Curry',
      ingredients: [
        { kind: 'measured', amount: '2', unit: 'cup', name: 'rice' },
        { kind: 'vague', name: 'salt' },
      ],
      steps: ['Cook.'],
    });

    // Schedule it 2 days out (inside the default today..+7 window).
    const inRange = addDaysISO(todayISO(), 2);
    await page.getByTestId('schedule-cook').click();
    await page.getByTestId('cook-date').fill(inRange);
    await page.getByTestId('cook-submit').click();
    await expect(page.getByTestId('cooking-history').getByText(/Upcoming \(1\)/)).toBeVisible();

    await page.locator('header').getByRole('link', { name: 'Shopping', exact: true }).click();
    const scheduled = page.getByTestId('shop-scheduled');
    await expect(scheduled.getByText(/1 recipe scheduled/)).toBeVisible();
    await page.getByTestId('add-scheduled').click();

    // The scheduled recipe's ingredients flow into the grocery list.
    await expect(page.getByRole('heading', { name: 'Groceries' })).toBeVisible();
    await expect(page.getByText(/2 cup.*rice/)).toBeVisible();
  });

  test('does not pull in recipes scheduled outside the range', async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Out Of Range',
      recipeTitle: 'Future Feast',
      ingredients: [{ kind: 'measured', amount: '1', unit: 'cup', name: 'quinoa' }],
      steps: ['Cook.'],
    });

    // Schedule 30 days out — well past the default +7 window.
    await page.getByTestId('schedule-cook').click();
    await page.getByTestId('cook-date').fill(addDaysISO(todayISO(), 30));
    await page.getByTestId('cook-submit').click();
    await expect(page.getByTestId('cooking-history').getByText(/Upcoming \(1\)/)).toBeVisible();

    await page.locator('header').getByRole('link', { name: 'Shopping', exact: true }).click();
    await expect(page.getByTestId('shop-scheduled').getByText(/0 recipes scheduled/)).toBeVisible();
    await expect(page.getByTestId('add-scheduled')).toBeDisabled();
  });
});
