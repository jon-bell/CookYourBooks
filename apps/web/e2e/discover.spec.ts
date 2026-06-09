import { test, expect } from './support/fixtures.js';
import { adminGet, seedPublicCollection } from './support/admin.js';
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

  // Regression: fork_collection used to rebuild its old->new id maps by
  // re-joining the inserted rows on natural keys (recipes on (sort_order,
  // title) etc.). Two recipes sharing a title + the default sort_order made
  // that join a cross product: row multiplication + cross-wired refs. Seed
  // exactly that collision and assert the fork is a faithful 1:1 copy.
  test('fork does not duplicate rows when recipes share title + sort_order', async ({
    authedPage: page,
  }) => {
    const seed = await seedPublicCollection({
      title: 'Collision Coll',
      recipes: [
        {
          // Two recipes with the SAME title and SAME sort_order (0).
          title: 'Dupe Recipe',
          sortOrder: 0,
          ingredients: [
            // Two ingredients sharing (sort_order, name) within the recipe.
            { name: 'flour', sortOrder: 0 },
            { name: 'flour', sortOrder: 0 },
            { name: 'sugar', sortOrder: 1 },
          ],
          instructions: [
            { stepNumber: 1, text: 'Mix flour.' },
            { stepNumber: 2, text: 'Add sugar.' },
          ],
          refs: [
            { instructionIndex: 0, ingredientIndex: 0 },
            { instructionIndex: 1, ingredientIndex: 2 },
          ],
        },
        {
          title: 'Dupe Recipe',
          sortOrder: 0,
          ingredients: [{ name: 'butter', sortOrder: 0 }],
          instructions: [{ stepNumber: 1, text: 'Melt butter.' }],
          refs: [{ instructionIndex: 0, ingredientIndex: 0 }],
        },
      ],
    });
    try {
      await page.getByRole('link', { name: 'Discover' }).click();
      await page.getByPlaceholder(/Search titles/).fill('Collision Coll');
      await expect(page.getByText('Collision Coll')).toBeVisible();
      await page.getByRole('button', { name: 'Fork to library' }).click();

      // Fork navigates to /collections/:id of the new copy.
      await expect(page).toHaveURL(/\/collections\/[0-9a-f-]+$/, { timeout: 15_000 });
      const forkedId = page.url().split('/collections/')[1]!;
      expect(forkedId).toMatch(/^[0-9a-f-]+$/);

      // Source counts (the truth the fork must match).
      const srcRecipes = await adminGet<{ id: string }[]>(
        `/rest/v1/recipes?select=id&collection_id=eq.${seed.collectionId}`,
      );
      const srcRecipeIds = srcRecipes.map((r) => r.id);
      const inList = (ids: string[]) => `in.(${ids.join(',')})`;
      const srcIng = await adminGet<{ id: string }[]>(
        `/rest/v1/ingredients?select=id&recipe_id=${inList(srcRecipeIds)}`,
      );
      const srcSteps = await adminGet<{ id: string }[]>(
        `/rest/v1/instructions?select=id&recipe_id=${inList(srcRecipeIds)}`,
      );
      const srcRefs = await adminGet<{ instruction_id: string }[]>(
        `/rest/v1/instruction_ingredient_refs?select=instruction_id&instruction_id=${inList(
          srcSteps.map((s) => s.id),
        )}`,
      );

      // Forked counts must EQUAL the source — no multiplication.
      const fRecipes = await adminGet<{ id: string }[]>(
        `/rest/v1/recipes?select=id&collection_id=eq.${forkedId}`,
      );
      const fRecipeIds = fRecipes.map((r) => r.id);
      expect(fRecipes.length).toBe(srcRecipes.length);

      const fIng = await adminGet<{ id: string }[]>(
        `/rest/v1/ingredients?select=id&recipe_id=${inList(fRecipeIds)}`,
      );
      expect(fIng.length).toBe(srcIng.length);

      const fSteps = await adminGet<{ id: string }[]>(
        `/rest/v1/instructions?select=id&recipe_id=${inList(fRecipeIds)}`,
      );
      expect(fSteps.length).toBe(srcSteps.length);

      // Refs: same count, and each forked ref must join an instruction and an
      // ingredient that belong to the SAME recipe (no cross-wiring).
      const fRefs = await adminGet<
        {
          instruction: { recipe_id: string } | null;
          ingredient: { recipe_id: string } | null;
        }[]
      >(
        `/rest/v1/instruction_ingredient_refs` +
          `?select=instruction:instructions(recipe_id),ingredient:ingredients(recipe_id)` +
          `&instruction_id=${inList(fSteps.map((s) => s.id))}`,
      );
      expect(fRefs.length).toBe(srcRefs.length);
      for (const ref of fRefs) {
        expect(ref.instruction?.recipe_id).toBeTruthy();
        expect(ref.ingredient?.recipe_id).toBe(ref.instruction?.recipe_id);
      }
    } finally {
      await seed.cleanup();
    }
  });
});
