import { seedUserLibrary } from './support/admin.js';
import { expect, signIn, test } from './support/fixtures.js';

// Leaving /search for a recipe and coming Back must bring the query, the
// results, AND the scroll position with it. Search state lives in the URL
// precisely so the POP remount re-renders from the React Query cache fast
// enough for the global scroll restoration to land its saved offset.
test.describe('Search state restoration', () => {
  test('back from a result restores query, results, and scroll offset', async ({ page, user }) => {
    await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Tall Book',
      recipeCount: 40,
      ingredientsPerRecipe: 1,
      instructionsPerRecipe: 1,
    });
    // Keep CI off the model CDN; the literal path is what this test exercises.
    await page.addInitScript(() => {
      (window as unknown as { __cybDisableEmbedder?: boolean }).__cybDisableEmbedder = true;
    });
    await signIn(page, user);
    await page.goto('/search');

    const input = page.getByPlaceholder(/Search by recipe/);
    await input.fill('Perf Recipe');
    // The debounced query lands in the URL rather than component state.
    await page.waitForURL(/\/search\?.*q=Perf\+Recipe/, { timeout: 5_000 });
    await expect(page.getByText('Perf Recipe 40', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);

    await page.getByText('Perf Recipe 40', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Perf Recipe 40' })).toBeVisible();

    await page.goBack();

    // The query text is back in the box…
    await expect(input).toHaveValue('Perf Recipe');
    // …the results re-rendered from cache…
    await expect(page.getByText('Perf Recipe 40', { exact: true })).toBeVisible({ timeout: 5_000 });
    // …and the page is scrolled where it was left.
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 })
      .toBeGreaterThan(1000);
  });

  test('a shared /search?q= link runs the search on arrival', async ({ page, user }) => {
    await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Tall Book',
      recipeCount: 3,
      ingredientsPerRecipe: 1,
      instructionsPerRecipe: 1,
    });
    await page.addInitScript(() => {
      (window as unknown as { __cybDisableEmbedder?: boolean }).__cybDisableEmbedder = true;
    });
    await signIn(page, user);
    await page.goto('/search?q=Perf+Recipe+2');

    await expect(page.getByPlaceholder(/Search by recipe/)).toHaveValue('Perf Recipe 2');
    await expect(page.getByText('Perf Recipe 2', { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('typing does not pile up back-stack entries', async ({ page, user }) => {
    await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Tall Book',
      recipeCount: 3,
      ingredientsPerRecipe: 1,
      instructionsPerRecipe: 1,
    });
    await page.addInitScript(() => {
      (window as unknown as { __cybDisableEmbedder?: boolean }).__cybDisableEmbedder = true;
    });
    await signIn(page, user);
    await page.goto('/library');
    await page.goto('/search');

    const input = page.getByPlaceholder(/Search by recipe/);
    // Three settled queries — each replaces, so none of them is a history entry.
    for (const term of ['Perf', 'Perf Recipe', 'Perf Recipe 1']) {
      await input.fill(term);
      await page.waitForTimeout(400);
    }
    await expect(page.getByText('Perf Recipe 1', { exact: true })).toBeVisible({ timeout: 5_000 });

    // One Back should leave /search entirely, not step through the query history.
    await page.goBack();
    await expect(page).toHaveURL(/\/library$/);
  });
});
