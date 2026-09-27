import { createTestUser } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { expect, signIn, test } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

/**
 * Seed two cache rows + two mappings for the test user. This skips
 * the edge function (which would need the USDA Vault secret + live
 * network) and exercises the hook → math → panel path with known
 * inputs.
 */
async function seedNutrition(opts: {
  userId: string;
  facts: Array<{
    source: 'USDA_FDC';
    source_id: string;
    description: string;
    calories_kcal: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
    portions?: { unit: string; grams: number }[];
  }>;
  mappings: Array<{
    ingredient_key: string;
    source: 'USDA_FDC';
    source_id: string;
  }>;
}): Promise<void> {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  await fetch(`${SUPABASE_URL}/rest/v1/nutrition_facts_cache`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      opts.facts.map((f) => ({
        ...f,
        portions: f.portions ?? [],
      })),
    ),
  });
  await fetch(`${SUPABASE_URL}/rest/v1/ingredient_nutrition_mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      opts.mappings.map((m) => ({
        ...m,
        owner_id: opts.userId,
      })),
    ),
  });
}

test.describe('Recipe nutrition panel', () => {
  test('renders totals and per-serving with both modes', async ({ page }) => {
    const u = await createTestUser('nutrition');
    try {
      // Seed two ingredients into the nutrition cache + mappings so
      // the hook resolves locally without hitting the edge function.
      await seedNutrition({
        userId: u.id,
        facts: [
          {
            // 200g of flour: 364 kcal, 10g protein per 100g
            source: 'USDA_FDC',
            source_id: 'flour-fixture',
            description: 'Wheat flour, all-purpose, unenriched',
            calories_kcal: 364,
            protein_g: 10,
            fat_g: 1,
            carbs_g: 76,
            // USDA reports 1 cup flour ≈ 125 g — overrides our generic
            // water-equivalent fallback.
            portions: [{ unit: 'cup', grams: 125 }],
          },
          {
            // 100g of butter: 717 kcal, 81g fat per 100g
            source: 'USDA_FDC',
            source_id: 'butter-fixture',
            description: 'Butter, stick, unsalted',
            calories_kcal: 717,
            protein_g: 1,
            fat_g: 81,
            carbs_g: 0,
            portions: [{ unit: 'tablespoon', grams: 14 }],
          },
        ],
        mappings: [
          {
            ingredient_key: 'flour',
            source: 'USDA_FDC',
            source_id: 'flour-fixture',
          },
          {
            ingredient_key: 'butter',
            source: 'USDA_FDC',
            source_id: 'butter-fixture',
          },
        ],
      });

      await signIn(page, u);
      await createRecipeViaUi(page, {
        collectionTitle: 'Nutrition Demo',
        recipeTitle: 'Shortbread',
        servings: { amount: '4' },
        ingredients: [
          // 2 cup flour → 250g (per the USDA portion override above)
          { kind: 'measured', amount: '2', unit: 'cup', name: 'flour' },
          // 7 tbsp butter → 98g
          { kind: 'measured', amount: '7', unit: 'tablespoon', name: 'butter' },
        ],
        steps: ['Cream butter and flour.', 'Bake 30 minutes.'],
      });

      const panel = page.getByTestId('recipe-nutrition-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Total recipe nutrition. 250g flour × 364 kcal/100g = 910;
      // 98g butter × 717 kcal/100g ≈ 702.66 → total ≈ 1613 kcal.
      // The panel rounds to whole kcal.
      await expect(panel).toContainText(/1613 kcal|1612 kcal|1614 kcal/);

      // Per serving (4 servings): 1613 / 4 ≈ 403.
      await expect(panel).toContainText(/40[0-5] kcal/);

      // Switch to weight mode + verify the math updates.
      await page.getByTestId('serving-mode-weight').check();
      // Default recipe weight is the sum of resolved ingredient grams
      // (250 + 98 = 348). Default serving is 200g (component default).
      // So per-serving kcal ≈ 1613 * (200/348) ≈ 927.
      await expect(panel).toContainText(/9[12][0-9] kcal/);

      // Change the serving size to 100g → ≈ 463 kcal.
      const servingInput = page.getByTestId('weight-serving');
      await servingInput.fill('100');
      await expect(panel).toContainText(/46[0-5] kcal/);
    } finally {
      await u.cleanup();
    }
  });

  test('per-ingredient breakdown lists every measured row with a match', async ({ page }) => {
    const u = await createTestUser('nutrition-rows');
    try {
      await seedNutrition({
        userId: u.id,
        facts: [
          {
            source: 'USDA_FDC',
            source_id: 'sugar-fixture',
            description: 'Sugar, granulated',
            calories_kcal: 387,
            protein_g: 0,
            fat_g: 0,
            carbs_g: 100,
            portions: [{ unit: 'cup', grams: 200 }],
          },
        ],
        mappings: [
          {
            ingredient_key: 'sugar',
            source: 'USDA_FDC',
            source_id: 'sugar-fixture',
          },
        ],
      });

      await signIn(page, u);
      await createRecipeViaUi(page, {
        collectionTitle: 'Breakdown',
        recipeTitle: 'Sweet Thing',
        ingredients: [
          { kind: 'measured', amount: '1', unit: 'cup', name: 'sugar' },
          // Vague ingredient — appears in the list, no nutrition.
          { kind: 'vague', name: 'salt to taste' },
        ],
        steps: ['Combine.'],
      });

      const panel = page.getByTestId('recipe-nutrition-panel');
      await panel.getByText(/Per-ingredient breakdown/).click();

      const sugarRow = panel.locator('tr', { hasText: 'sugar' });
      await expect(sugarRow).toContainText('Sugar, granulated');
      await expect(sugarRow).toContainText(/200\s*g/);

      const saltRow = panel.locator('tr', { hasText: 'salt to taste' });
      await expect(saltRow).toContainText(/no match/);
    } finally {
      await u.cleanup();
    }
  });
});

/**
 * Seed rows into `nutrition_foods_master` — the table the local
 * essentials mirror is pulled from. Unlike `seedNutrition` above, this
 * exercises the actual matcher (`searchLocalEssentials`), because no
 * mapping exists for these ingredients and the hook has to pick a row.
 */
async function seedMasterFoods(
  foods: Array<{
    source_id: string;
    data_type: 'Foundation' | 'SR Legacy' | 'Survey (FNDDS)';
    description: string;
    calories_kcal: number | null;
  }>,
): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/nutrition_foods_master`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(
      foods.map((f) => ({
        source: 'USDA_FDC',
        brand: null,
        brand_owner: null,
        protein_g: 1,
        fat_g: 1,
        carbs_g: 1,
        portions: [],
        ...f,
      })),
    ),
  });
}

test.describe('Ingredient → USDA matching', () => {
  // Each of these three ingredients had a specific, reproducible wrong
  // answer in production. The decoys below are the rows that actually
  // won, so a regression in the ranker fails this test rather than
  // quietly deflating someone's nutrition panel.
  test('picks the food, not a substring or calorie-less collision', async ({ page }) => {
    const u = await createTestUser('nutrition-match');
    try {
      await seedMasterFoods([
        // "honey" used to match "honeydew" because the blob was matched
        // with LIKE '%honey%'.
        { source_id: 'm-honey', data_type: 'SR Legacy', description: 'Honey', calories_kcal: 304 },
        {
          source_id: 'm-honeydew',
          data_type: 'Foundation',
          description: 'Melons, honeydew, raw',
          calories_kcal: 36,
        },
        // "ground black pepper" used to match ground turkey: Foundation
        // was the FIRST sort key, so a row matching one token beat a row
        // matching all of them.
        {
          source_id: 'm-pepper',
          data_type: 'SR Legacy',
          description: 'Spices, pepper, black',
          calories_kcal: 251,
        },
        {
          source_id: 'm-turkey',
          data_type: 'Foundation',
          description: 'Turkey, ground, 93% lean, 7% fat, pan-broiled crumbles',
          calories_kcal: 176,
        },
        // "unsalted butter" used to match a Foundation row carrying NO
        // calorie data, which silently contributed zero.
        {
          source_id: 'm-butter-null',
          data_type: 'Foundation',
          description: 'Butter, stick, unsalted',
          calories_kcal: null,
        },
        {
          source_id: 'm-butter',
          data_type: 'Survey (FNDDS)',
          description: 'Butter, NFS',
          calories_kcal: 717,
        },
      ]);

      await signIn(page, u);
      await createRecipeViaUi(page, {
        collectionTitle: 'Matching',
        recipeTitle: 'Decoys',
        ingredients: [
          { kind: 'measured', amount: '2', unit: 'tablespoon', name: 'honey' },
          { kind: 'measured', amount: '1', unit: 'teaspoon', name: 'ground black pepper' },
          { kind: 'measured', amount: '3', unit: 'tablespoon', name: 'unsalted butter' },
        ],
        steps: ['Combine.'],
      });

      const panel = page.getByTestId('recipe-nutrition-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByText(/Per-ingredient breakdown/).click();

      const honeyRow = panel.locator('tr', { hasText: 'honey' });
      await expect(honeyRow).toContainText('Honey');
      await expect(honeyRow).not.toContainText('honeydew');

      const pepperRow = panel.locator('tr', { hasText: 'ground black pepper' });
      await expect(pepperRow).toContainText('Spices, pepper, black');
      await expect(pepperRow).not.toContainText('Turkey');

      // The calorie-less Foundation row must never be chosen, even
      // though its description is the closest textual match.
      const butterRow = panel.locator('tr', { hasText: 'unsalted butter' });
      await expect(butterRow).toContainText('Butter, NFS');
      await expect(butterRow).not.toContainText('stick');
    } finally {
      await u.cleanup();
    }
  });

  test('declines to match a string naming two foods', async ({ page }) => {
    const u = await createTestUser('nutrition-compound');
    try {
      await seedMasterFoods([
        {
          source_id: 'm-salt',
          data_type: 'SR Legacy',
          description: 'Salt, table',
          calories_kcal: 0,
        },
      ]);
      await signIn(page, u);
      await createRecipeViaUi(page, {
        collectionTitle: 'Compound',
        recipeTitle: 'Seasoned',
        ingredients: [{ kind: 'measured', amount: '1', unit: 'teaspoon', name: 'salt and pepper' }],
        steps: ['Season.'],
      });

      const panel = page.getByTestId('recipe-nutrition-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByText(/Per-ingredient breakdown/).click();

      // One row cannot represent two foods, so we report it as unmatched
      // rather than silently counting only the salt.
      const row = panel.locator('tr', { hasText: 'salt and pepper' });
      await expect(row).toContainText(/no match/);
    } finally {
      await u.cleanup();
    }
  });
});
