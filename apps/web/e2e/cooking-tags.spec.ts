import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Recipe tags', () => {
  test('adds and removes tags and browses by tag', async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Tagged',
      recipeTitle: 'Weeknight Pasta',
      ingredients: [{ kind: 'measured', amount: '1', unit: 'cup', name: 'pasta' }],
      steps: ['Boil.'],
    });
    const recipeUrl = page.url();

    const editor = page.getByTestId('tag-editor');
    await editor.getByTestId('tag-input').fill('weeknight');
    await editor.getByTestId('tag-input').press('Enter');
    await expect(editor.getByText('weeknight')).toBeVisible();

    // Browse by the tag.
    await page.goto('/tags/weeknight');
    const results = page.getByTestId('tag-results');
    await expect(results.getByRole('link', { name: 'Weeknight Pasta' })).toBeVisible();

    // Remove the tag; it disappears from the browse results.
    await page.goto(recipeUrl);
    await expect(page.getByTestId('tag-editor').getByText('weeknight')).toBeVisible();
    await page.getByTestId('tag-editor').getByRole('button', { name: 'Remove tag weeknight' }).click();
    await expect(page.getByTestId('tag-editor').getByText('weeknight')).toHaveCount(0);

    await page.goto('/tags/weeknight');
    await expect(
      page.getByText('No recipes match the selected tags.'),
    ).toBeVisible();
  });
});
