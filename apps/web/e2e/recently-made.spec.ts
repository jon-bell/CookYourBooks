import { test, expect, signIn, waitForSynced } from './support/fixtures.js';
import { seedUserLibrary } from './support/admin.js';

// "Recently made" sorting is derived from COOKED cooking_events. One seeded
// collection, log a cook on the second recipe, and the made-sort should
// float it to the top on all three surfaces (collection browser, all-recipes
// gallery, library grid) and survive a reload via localStorage.
test.describe('Recently made sort', () => {
  test('cooked recipe floats to the top; empty state shows a hint; choice persists', async ({
    page,
    user,
  }) => {
    const { collectionId } = await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Made Sort Book',
      recipeCount: 3,
      ingredientsPerRecipe: 1,
      instructionsPerRecipe: 1,
    });
    // A second, never-cooked collection so the library made-sort has
    // something to beat. Seeded second so 'recently updated' would have
    // put it FIRST — proving the made-sort actually reorders.
    await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Untouched Book',
      recipeCount: 1,
      ingredientsPerRecipe: 1,
      instructionsPerRecipe: 1,
    });
    await signIn(page, user);
    await page.goto(`/collections/${collectionId}`);
    await expect(page.getByRole('heading', { name: 'Made Sort Book' })).toBeVisible();

    // Nothing cooked yet → selecting "Recently made" shows the hint.
    await page.getByLabel('Sort').selectOption('made');
    await expect(page.getByTestId('empty-made-hint')).toBeVisible();

    // Log a cook on recipe 2.
    await page.getByText('Perf Recipe 2', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Perf Recipe 2' })).toBeVisible();
    await page.getByTestId('i-made-this').click();
    await page.getByTestId('cook-submit').click();
    await expect(
      page.getByTestId('cooking-history').getByRole('heading', { name: /History \(1\)/ }),
    ).toBeVisible();

    // Back on the collection the persisted "Recently made" sort is still
    // selected and the cooked recipe now leads; the hint is gone.
    await page.goto(`/collections/${collectionId}`);
    await expect(page.getByLabel('Sort')).toHaveValue('made');
    await expect(page.getByTestId('empty-made-hint')).toHaveCount(0);
    const cards = page.locator('main ul a[href*="/recipes/"]');
    await expect(cards.first()).toContainText('Perf Recipe 2');

    // The all-recipes gallery has its own sort; "Recently made" leads with
    // the cooked recipe there too.
    await page.goto('/');
    await waitForSynced(page);
    await page.getByLabel('Sort').selectOption('made');
    await expect(cards.first()).toContainText('Perf Recipe 2');

    // The library grid sorts collections by their most recent cook.
    await page.goto('/library');
    await page.getByLabel('Sort').selectOption('made');
    const collectionCards = page.locator('main ul a[href*="/collections/"]');
    await expect(collectionCards.first()).toContainText('Made Sort Book');
  });
});
