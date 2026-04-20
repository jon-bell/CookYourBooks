import { test, expect } from './support/fixtures.js';
import { seedPublicCollection } from './support/admin.js';

test.describe('Discover + fork', () => {
  test('lists a public collection seeded by another user', async ({ authedPage: page }) => {
    const seed = await seedPublicCollection({
      title: 'Shared Greens',
      recipeTitles: ['Salad 1', 'Salad 2'],
    });
    try {
      await page.getByRole('link', { name: 'Discover' }).click();
      await page.getByPlaceholder(/Search titles/).fill('Shared Greens');
      await expect(page.getByText('Shared Greens')).toBeVisible();
      await expect(page.getByText(/2 recipes/)).toBeVisible();
    } finally {
      await seed.cleanup();
    }
  });

  test('filters by source type', async ({ authedPage: page }) => {
    const seed = await seedPublicCollection({
      title: 'Only Personal Set',
      recipeTitles: ['Thing'],
    });
    try {
      await page.getByRole('link', { name: 'Discover' }).click();
      // Filtering out PERSONAL should hide the seed; filtering to PERSONAL shows it.
      await page.getByRole('combobox').selectOption('PUBLISHED_BOOK');
      await expect(page.getByText('Only Personal Set')).toHaveCount(0);
      await page.getByRole('combobox').selectOption('PERSONAL');
      await expect(page.getByText('Only Personal Set')).toBeVisible();
    } finally {
      await seed.cleanup();
    }
  });

  test('fork copies the collection + recipes into the user library', async ({
    authedPage: page,
  }) => {
    const seed = await seedPublicCollection({
      title: 'Forkable Recipes',
      recipeTitles: ['Foo', 'Bar'],
    });
    try {
      await page.getByRole('link', { name: 'Discover' }).click();
      await page.getByPlaceholder(/Search titles/).fill('Forkable Recipes');
      await expect(page.getByText('Forkable Recipes')).toBeVisible();
      await page.getByRole('button', { name: 'Fork to library' }).click();

      // Fork navigates to the new collection page.
      await expect(page.getByRole('heading', { name: 'Forkable Recipes' })).toBeVisible({
        timeout: 15_000,
      });
      // Scope to the main content — dnd-kit injects an accessibility live
      // region whose text happens to collide with short recipe names.
      await expect(page.locator('main').getByRole('link', { name: /^Foo/ })).toBeVisible();
      await expect(page.locator('main').getByRole('link', { name: /^Bar/ })).toBeVisible();

      // Library should show it as a private (non-public) copy.
      await page.getByRole('link', { name: 'Library' }).click();
      const card = page.locator('li', { hasText: 'Forkable Recipes' });
      await expect(card).toBeVisible();
      await expect(card.getByText('Public')).toHaveCount(0);
    } finally {
      await seed.cleanup();
    }
  });
});
