import { test, expect, signIn } from './support/fixtures.js';
import { seedUserLibrary } from './support/admin.js';

// Back must return to the same scroll position (custom restoration — the
// declarative router has none), and pushing a new route starts at the top.
test.describe('Scroll restoration', () => {
  test('back returns to the saved offset; push scrolls to top', async ({ page, user }) => {
    const { collectionId } = await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Tall Book',
      recipeCount: 40,
      ingredientsPerRecipe: 1,
      instructionsPerRecipe: 1,
    });
    await signIn(page, user);
    await page.goto(`/collections/${collectionId}`);
    await expect(page.getByText('Perf Recipe 1', { exact: true })).toBeVisible();

    // Scroll deep into the list, then open a recipe (PUSH → top).
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    await page.getByText('Perf Recipe 40', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Perf Recipe 40' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(50);

    // Going back restores the saved offset once the list has re-rendered.
    await page.goBack();
    await expect(page.getByText('Perf Recipe 1', { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 })
      .toBeGreaterThan(1000);
  });
});
