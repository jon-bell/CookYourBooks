import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';
import { createUserRecipe, waitForEmbedding } from './support/embeddings.js';

// Browser-level semantic success with the REAL model (no __cybDisableEmbedder).
// Documents are embedded by the edge worker (native gte-small); the browser
// downloads Xenova/gte-small to embed the QUERY and runs cosine over the
// synced local vectors. This proves (a) the real model loads in Chromium,
// (b) the semantic path returns a lexically-disjoint match a substring search
// could never find, and (c) edge-document vs browser-query vectors are
// cosine-comparable across the two inference stacks.
test.describe('Semantic search (real model)', () => {
  // The ~30 MB model download dominates; allow plenty of headroom.
  test.describe.configure({ timeout: 120_000 });

  test('ranks the semantically-closest recipe first for disjoint queries', async ({
    user,
    authedPage: page,
  }) => {
    const bolognese = await createUserRecipe({
      ownerId: user.id,
      collectionTitle: 'Weeknight',
      recipeTitle: 'Spaghetti Bolognese',
      description: 'Classic Italian comfort dish.',
      ingredients: ['ground beef', 'tomato', 'onion'],
    });
    const cake = await createUserRecipe({
      ownerId: user.id,
      collectionTitle: 'Weeknight',
      collectionId: bolognese.collectionId,
      recipeTitle: 'Chocolate Cake',
      description: 'Rich cocoa dessert.',
      ingredients: ['cocoa', 'flour', 'sugar'],
    });
    await waitForEmbedding(bolognese.recipeId, { timeoutMs: 80_000 });
    await waitForEmbedding(cake.recipeId, { timeoutMs: 30_000 });

    // Fresh load → the initial pull brings the recipes + their vectors into
    // the local SQLite cache that /search reads.
    await page.goto('/search');
    await expect(page.locator('header button', { hasText: 'Synced' })).toBeVisible({
      timeout: 15_000,
    });

    const input = page.getByPlaceholder(/Search by recipe/);
    const topResult = page.locator('ul li a[href*="/recipes/"]').first();

    // Neither query phrase appears verbatim in any recipe field, so the
    // substring fallback returns nothing — any result here is purely
    // semantic, and (gte-small's compressed cosines mean both recipes
    // clear the floor, so) the *ranking* must track meaning. The savoury
    // query must surface the pasta dish on top…
    await input.fill('hearty pasta with meat ragu');
    await expect(topResult).toContainText('Spaghetti Bolognese', { timeout: 60_000 });
    await expect(page.getByText(/showing literal matches/)).toHaveCount(0);
    await expect(page.getByText(/Preparing semantic search/)).toHaveCount(0);

    // …and flipping the query meaning must flip the ranking.
    await input.fill('warm gooey sweet treat');
    await expect(topResult).toContainText('Chocolate Cake', { timeout: 30_000 });
  });
});

// Degradation: with the embedder disabled the page must fall back to the
// substring search AND surface the "unavailable" hint. (The fast substring
// suite in search.spec.ts never asserts that hint — this closes the gap.)
test.describe('Semantic search degradation', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __cybDisableEmbedder?: boolean }).__cybDisableEmbedder = true;
    });
  });

  test('disabled embedder falls back to substring and shows the unavailable hint', async ({
    authedPage: page,
  }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Dinners',
      recipeTitle: 'Chicken Soup',
      ingredients: [
        { kind: 'measured', amount: '1', unit: 'cup', name: 'stock' },
        { kind: 'vague', name: 'parsley' },
      ],
      steps: ['Simmer.'],
    });
    await page.locator('header').getByRole('link', { name: 'Search', exact: true }).click();
    await page.waitForURL(/\/search$/);
    await page.getByPlaceholder(/Search by recipe/).fill('chicken');
    await expect(page.getByText(/Semantic search unavailable/)).toBeVisible();
    await expect(page.getByText('Chicken Soup')).toBeVisible({ timeout: 5000 });
  });
});
