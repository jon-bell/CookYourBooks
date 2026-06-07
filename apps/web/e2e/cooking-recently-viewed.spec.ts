import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Recently viewed (local-only)', () => {
  test('lists opened recipes newest-first on this device', async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'History Box',
      recipeTitle: 'First Recipe',
      ingredients: [{ kind: 'vague', name: 'love' }],
      steps: ['Cook.'],
    });
    const firstUrl = page.url();

    await createRecipeViaUi(page, {
      collectionTitle: 'History Box Two',
      recipeTitle: 'Second Recipe',
      ingredients: [{ kind: 'vague', name: 'time' }],
      steps: ['Cook.'],
    });

    // Re-open the first so it becomes the most-recent view.
    await page.goto(firstUrl);
    await expect(page.getByRole('heading', { name: 'First Recipe' })).toBeVisible();

    await page.goto('/cooking/recent');
    const list = page.getByTestId('recently-viewed-list');
    await expect(list.getByRole('link', { name: 'First Recipe' })).toBeVisible();
    await expect(list.getByRole('link', { name: 'Second Recipe' })).toBeVisible();
    // Most-recent first: First Recipe (re-opened) precedes Second Recipe.
    const items = list.locator('li');
    await expect(items.first()).toContainText('First Recipe');
  });

  test('view history is device-local: a fresh storage context starts empty', async ({
    authedPage: page,
    user,
    browser,
  }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Local Only',
      recipeTitle: 'Private View',
      ingredients: [{ kind: 'vague', name: 'salt' }],
      steps: ['Cook.'],
    });
    await page.goto('/cooking/recent');
    await expect(
      page.getByTestId('recently-viewed-list').getByText('Private View'),
    ).toBeVisible();

    // A brand-new browser context (separate IndexedDB) for the SAME user
    // must NOT inherit the view history — it lives only on the first device.
    const ctx = await browser.newContext();
    const page2 = await ctx.newPage();
    const { signIn } = await import('./support/fixtures.js');
    await signIn(page2, user);
    await page2.goto('/cooking/recent');
    await expect(page2.getByText('Recipes you open will show up here.')).toBeVisible();
    await ctx.close();
  });
});
