import { expect, test, waitForSynced } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Cook multiple recipes together', () => {
  test('schedules two recipes for a day and cooks them together', async ({ authedPage: page }) => {
    test.setTimeout(60_000);

    // Two recipes, both scheduled for today (the dialog defaults to today).
    await createRecipeViaUi(page, {
      collectionTitle: 'Feast One',
      recipeTitle: 'Roast Veg',
      ingredients: [{ kind: 'measured', amount: '2', unit: 'cup', name: 'carrots' }],
      steps: ['Roast the veg.'],
    });
    await page.getByTestId('schedule-cook').click();
    await page.getByTestId('cook-submit').click();
    // Scheduling queues a sync write; the cooking-history count reflects it only
    // after that write settles. Wait for sync before asserting (was racing 5s).
    await waitForSynced(page);
    await expect(page.getByTestId('cooking-history').getByText(/Upcoming \(1\)/)).toBeVisible();

    await createRecipeViaUi(page, {
      collectionTitle: 'Feast Two',
      recipeTitle: 'Gravy',
      ingredients: [{ kind: 'measured', amount: '1', unit: 'cup', name: 'stock' }],
      steps: ['Simmer the gravy.'],
    });
    await page.getByTestId('schedule-cook').click();
    await page.getByTestId('cook-submit').click();
    // Scheduling queues a sync write; the cooking-history count reflects it only
    // after that write settles. Wait for sync before asserting (was racing 5s).
    await waitForSynced(page);
    await expect(page.getByTestId('cooking-history').getByText(/Upcoming \(1\)/)).toBeVisible();

    // From the calendar, cook today's two recipes together.
    await page.locator('header').getByRole('link', { name: 'Cooking', exact: true }).click();
    await page.getByTestId('cook-together').click();
    await page.waitForURL(/\/cooking\/cook\//);

    // Both recipes + a combined ingredient list are shown.
    await expect(page.getByTestId('cook-session-recipe')).toHaveCount(2);
    const combined = page.getByTestId('combined-ingredients');
    await expect(combined.getByText(/2 cup.*carrots/)).toBeVisible();
    await expect(combined.getByText(/1 cup.*stock/)).toBeVisible();

    // Mark them all cooked.
    await page.getByTestId('mark-all-cooked').click();
    // Marking cooked queues sync writes for each entry; the button disappears
    // only once the calendar reflects them. Wait for sync before asserting.
    await waitForSynced(page);
    await expect(page.getByTestId('mark-all-cooked')).toHaveCount(0);

    // Back on a recipe, the entry is now in history (cooked), not upcoming.
    await page.goto('/cooking');
    await page.getByTestId('calendar-day-detail').getByRole('link', { name: 'Roast Veg' }).click();
    await expect(page.getByTestId('cooking-history').getByText(/History \(1\)/)).toBeVisible();
  });
});
