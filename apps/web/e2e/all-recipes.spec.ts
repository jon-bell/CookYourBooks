import { expect, test, waitForSynced } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Library-wide Recipes gallery', () => {
  test('lists every non-empty recipe and filters by recipe or by book', async ({
    authedPage: page,
  }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Alpha Cookbook',
      recipeTitle: 'Pancakes',
      ingredients: [{ kind: 'vague', name: 'flour' }],
      steps: ['Mix and fry.'],
    });
    await createRecipeViaUi(page, {
      collectionTitle: 'Beta Cookbook',
      recipeTitle: 'Waffles',
      ingredients: [{ kind: 'vague', name: 'flour' }],
      steps: ['Mix and press.'],
    });

    // Open the library-wide gallery from the primary nav.
    await page.getByRole('link', { name: 'Recipes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();
    await waitForSynced(page);

    const cards = page.locator('ul a[href*="/recipes/"]');
    await expect(cards.filter({ hasText: 'Pancakes' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Waffles' })).toHaveCount(1);

    const search = page.getByRole('searchbox', { name: 'Search recipes or cookbooks' });

    // Filter by recipe title.
    await search.fill('Waffles');
    await expect(cards.filter({ hasText: 'Waffles' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Pancakes' })).toHaveCount(0);

    // Filter by book (collection title) — narrows to that book's recipes.
    await search.fill('Alpha');
    await expect(cards.filter({ hasText: 'Pancakes' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Waffles' })).toHaveCount(0);

    // Each card names its owning book with a link straight to the
    // collection (a sibling of the recipe link, so the card click is
    // unaffected).
    await search.fill('');
    const pancakesCard = page.locator('li', { hasText: 'Pancakes' });
    await pancakesCard.getByRole('link', { name: 'Alpha Cookbook' }).click();
    await expect(page).toHaveURL(/\/collections\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name: 'Alpha Cookbook' })).toBeVisible();

    // Tapping a card opens that recipe.
    await page.goBack();
    await cards.filter({ hasText: 'Pancakes' }).click();
    await expect(page).toHaveURL(/\/recipes\//);
    await expect(page.getByRole('heading', { name: 'Pancakes' })).toBeVisible();
  });
});
