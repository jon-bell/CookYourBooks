import { test, expect } from './support/fixtures.js';
import { seedPublicCollection } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';

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

  test('public-collection card lists recipe titles', async ({ authedPage: page }) => {
    const seed = await seedPublicCollection({
      title: 'TitleListing Trial',
      recipeTitles: ['Garlic Confit', 'Pickled Onions', 'Pan Sauce'],
    });
    try {
      await page.getByRole('link', { name: 'Discover' }).click();
      await page.getByPlaceholder(/Search titles/).fill('TitleListing Trial');
      const card = page.getByTestId(`public-card-${seed.collectionId}`);
      await expect(card).toBeVisible();
      // Recipe titles render inline; only the first 5 are shown by default
      // (this seed has 3 so all appear).
      await expect(card.getByText('Garlic Confit')).toBeVisible();
      await expect(card.getByText('Pickled Onions')).toBeVisible();
      await expect(card.getByText('Pan Sauce')).toBeVisible();
    } finally {
      await seed.cleanup();
    }
  });

  test('global cookbook catalog card lists ToC entries', async ({ authedPage: page }) => {
    // Direct service-role inserts: an admin-curated cookbook in the
    // catalog with three ToC entries. Test cleanup deletes the rows.
    const isbn = `9999${Math.random().toString().slice(2, 11)}`;
    const cbResp = await fetch(`${SUPABASE_URL}/rest/v1/global_cookbooks`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ title: 'ToC Trial Cookbook', author: 'Test Author', isbn }),
    });
    const [cb] = (await cbResp.json()) as { id: string }[];
    const cookbookId = cb!.id;
    try {
      const entries = [
        { cookbook_id: cookbookId, title: 'Chapter 1: Stocks', page_number: 12, sort_order: 0 },
        { cookbook_id: cookbookId, title: 'Chapter 2: Soups', page_number: 34, sort_order: 1 },
        { cookbook_id: cookbookId, title: 'Chapter 3: Salads', page_number: 56, sort_order: 2 },
      ];
      await fetch(`${SUPABASE_URL}/rest/v1/global_toc_entries`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(entries),
      });

      await page.getByRole('link', { name: 'Discover' }).click();
      await page.getByPlaceholder(/Search titles/).fill('ToC Trial Cookbook');
      const card = page.getByTestId(`catalog-card-${cookbookId}`);
      await expect(card).toBeVisible();
      await expect(card.getByText('Chapter 1: Stocks')).toBeVisible();
      await expect(card.getByText('p. 12')).toBeVisible();
      await expect(card.getByText('Chapter 2: Soups')).toBeVisible();
      await expect(card.getByText('Chapter 3: Salads')).toBeVisible();
    } finally {
      await fetch(`${SUPABASE_URL}/rest/v1/global_cookbooks?id=eq.${cookbookId}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      });
    }
  });

  test('long recipe lists get a "Show all" toggle', async ({ authedPage: page }) => {
    const recipeTitles = Array.from({ length: 8 }, (_, i) => `Recipe ${i + 1}`);
    const seed = await seedPublicCollection({
      title: 'ManyRecipes Coll',
      recipeTitles,
    });
    try {
      await page.getByRole('link', { name: 'Discover' }).click();
      await page.getByPlaceholder(/Search titles/).fill('ManyRecipes Coll');
      const card = page.getByTestId(`public-card-${seed.collectionId}`);
      await expect(card).toBeVisible();
      // First 5 visible by default; 6-8 hidden behind the toggle.
      await expect(card.getByText('Recipe 5')).toBeVisible();
      await expect(card.getByText('Recipe 8')).not.toBeVisible();
      await card.getByRole('button', { name: 'Show all 8' }).click();
      await expect(card.getByText('Recipe 8')).toBeVisible();
      await card.getByRole('button', { name: 'Show less' }).click();
      await expect(card.getByText('Recipe 8')).not.toBeVisible();
    } finally {
      await seed.cleanup();
    }
  });
});
