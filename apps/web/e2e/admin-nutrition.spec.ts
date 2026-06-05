import { test, expect, signIn } from './support/fixtures.js';
import { adminGet, createTestUser } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';

/**
 * Admin nutrition flow:
 *   1. Tweak a cached fact's calories_kcal via the edit dialog →
 *      verify the value persisted to the server.
 *   2. Add a platform-default mapping (using the bulk-load with a
 *      pre-seeded cache hit) → verify the mapping landed in
 *      ingredient_nutrition_mappings with owner_id NULL → and that
 *      it's served back to a regular user's recipe.
 */

async function seedCache(opts: {
  source: 'USDA_FDC';
  source_id: string;
  description: string;
  calories_kcal: number;
  protein_g?: number;
  fat_g?: number;
  carbs_g?: number;
  portions?: { unit: string; grams: number }[];
}): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/nutrition_facts_cache`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      ...opts,
      portions: opts.portions ?? [],
    }),
  });
}

test.describe('Admin nutrition surface', () => {
  test('admin edits cached fact via the tweak dialog', async ({ page }) => {
    const admin = await createTestUser('nutr-admin', { admin: true });
    try {
      await seedCache({
        source: 'USDA_FDC',
        source_id: 'tweak-fixture',
        description: 'Tweakable Fixture Food',
        calories_kcal: 200,
        protein_g: 5,
      });

      await signIn(page, admin);
      await page.goto('/admin/nutrition');

      // Find the row + open the edit dialog.
      await page.getByTestId('cache-filter').fill('Tweakable');
      const editBtn = page.getByTestId('cache-edit-tweak-fixture');
      await expect(editBtn).toBeVisible({ timeout: 10_000 });
      await editBtn.click();

      // Bump calories from 200 → 350 and save.
      const caloriesInput = page.getByTestId('cache-edit-calories_kcal');
      await caloriesInput.fill('350');
      await page.getByTestId('cache-edit-save').click();
      // Save resolves the dialog by setting `editing` to null. Waiting
      // for the dialog to actually disappear is the cleanest signal
      // that the RPC round-trip has landed — otherwise `adminGet`
      // races it and reads the pre-update value.
      await expect(page.getByTestId('cache-edit-save')).toBeHidden({ timeout: 10_000 });

      // Verify on the server.
      type R = Array<{ calories_kcal: number }>;
      const remote = await adminGet<R>(
        `/rest/v1/nutrition_facts_cache?source_id=eq.tweak-fixture&select=calories_kcal`,
      );
      expect(remote[0]?.calories_kcal).toBe(350);
    } finally {
      await admin.cleanup();
    }
  });

  test('platform default mapping flows through to a regular user', async ({ browser }) => {
    const admin = await createTestUser('nutr-admin-2', { admin: true });
    const reader = await createTestUser('nutr-reader');
    try {
      await seedCache({
        source: 'USDA_FDC',
        source_id: 'platform-flour-fixture',
        description: 'Wheat flour, platform default',
        calories_kcal: 360,
        protein_g: 10,
        fat_g: 1,
        carbs_g: 76,
        portions: [{ unit: 'cup', grams: 125 }],
      });

      // The bulk-load preview calls the edge function, which would
      // need the USDA Vault key (not set in CI). Skip the preview and
      // service-role-insert the mapping directly to verify the
      // user-facing read path.
      await fetch(`${SUPABASE_URL}/rest/v1/ingredient_nutrition_mappings`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          owner_id: null,
          ingredient_key: 'flour',
          source: 'USDA_FDC',
          source_id: 'platform-flour-fixture',
        }),
      });

      // Admin sees the new platform mapping in their list.
      const adminCtx = await browser.newContext();
      const adminPage = await adminCtx.newPage();
      try {
        await signIn(adminPage, admin);
        await adminPage.goto('/admin/nutrition');
        await expect(adminPage.getByTestId('platform-mapping-flour')).toBeVisible({
          timeout: 10_000,
        });
      } finally {
        await adminCtx.close();
      }

      // Regular user with no personal mapping sees the platform
      // default applied to a recipe.
      const readerCtx = await browser.newContext();
      const readerPage = await readerCtx.newPage();
      try {
        await signIn(readerPage, reader);
        await readerPage.getByRole('link', { name: 'New collection' }).click();
        await readerPage.getByLabel('Title').fill('Platform Test');
        await readerPage.getByRole('button', { name: 'Create' }).click();
        await expect(
          readerPage.getByRole('heading', { name: 'Platform Test' }),
        ).toBeVisible();

        await readerPage.getByRole('link', { name: 'Add recipe' }).click();
        await readerPage.locator('main input').first().fill('Bread');
        const ingRow = readerPage
          .locator('section', { hasText: 'Ingredients' })
          .locator('ul > li')
          .first();
        await ingRow.locator('select').first().selectOption('MEASURED');
        await ingRow.locator('input[placeholder=amount]').fill('2');
        await ingRow.locator('select').nth(1).selectOption('cup');
        await ingRow.locator('input[placeholder="ingredient name"]').fill('flour');
        await readerPage.locator('ol textarea').first().fill('Mix.');
        await readerPage.getByRole('button', { name: 'Save recipe' }).click();
        await expect(readerPage.getByRole('heading', { name: 'Bread' })).toBeVisible();

        // 2 cup × 125 g/cup = 250 g; × 360 kcal/100g = 900 kcal.
        const panel = readerPage.getByTestId('recipe-nutrition-panel');
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect(panel).toContainText(/90[0-9] kcal|89[5-9] kcal/);
      } finally {
        await readerCtx.close();
      }
    } finally {
      await admin.cleanup();
      await reader.cleanup();
    }
  });
});
