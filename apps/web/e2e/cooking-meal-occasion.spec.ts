import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Meal slot + occasion picker', () => {
  test('logs a cook with a meal slot and a created occasion', async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Sunday Kitchen',
      recipeTitle: 'Pot Roast',
      ingredients: [{ kind: 'vague', name: 'beef' }],
      steps: ['Roast.'],
    });

    await page.getByTestId('i-made-this').click();

    // Pick a meal slot.
    await page.getByTestId('meal-slot').getByRole('button', { name: 'Dinner' }).click();
    await expect(
      page.getByTestId('meal-slot').getByRole('button', { name: 'Dinner' }),
    ).toHaveAttribute('aria-pressed', 'true');

    // Create a free-form occasion via the react-select creatable.
    await page.locator('.cyb-select__control').click();
    await page.keyboard.type('Sunday roast');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cyb-select__single-value')).toHaveText('Sunday roast');

    await page.getByTestId('cook-submit').click();

    const history = page.getByTestId('cooking-history');
    await expect(history.getByText('Dinner')).toBeVisible();
    await expect(history.getByText('Sunday roast')).toBeVisible();
  });

  test('suggests a previously-used occasion in the autocomplete', async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Repeat Kitchen',
      recipeTitle: 'Weeknight Tacos',
      ingredients: [{ kind: 'vague', name: 'tortillas' }],
      steps: ['Assemble.'],
    });
    const recipeUrl = page.url();

    // First cook establishes an occasion in the vocabulary.
    await page.getByTestId('i-made-this').click();
    await page.locator('.cyb-select__control').click();
    await page.keyboard.type('Taco Tuesday');
    await page.keyboard.press('Enter');
    await page.getByTestId('cook-submit').click();
    await expect(page.getByTestId('cooking-history').getByText('Taco Tuesday')).toBeVisible();

    // A second cook: typing the prefix surfaces the saved occasion as an option.
    await page.goto(recipeUrl);
    await page.getByTestId('i-made-this').click();
    await page.locator('.cyb-select__control').click();
    await page.keyboard.type('Taco');
    await expect(page.locator('.cyb-select__option', { hasText: 'Taco Tuesday' })).toBeVisible();
  });
});
