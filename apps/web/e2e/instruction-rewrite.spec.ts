import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';
import {
  configureOcrKey,
  seedRewriteFixture,
  triggerWorker,
} from './support/imports.js';

/**
 * End-to-end happy path for "Improve instructions". Creates a recipe via
 * the UI, seeds a rewrite_test_fixtures row keyed against any recipe
 * (`recipe_id='*'`), clicks Improve, drains the worker by hand, then
 * verifies Cook Mode renders the rewritten atomic steps plus an
 * interactive countdown timer for the step that has a duration.
 *
 * The worker is in mock mode (`OCR_MOCK_MODE=1`), so the OCR API key
 * value doesn't matter — we just need a row in `user_ocr_keys` to
 * exist before `rewrite_start` runs.
 */

test.describe('Instruction rewriting', () => {
  test.slow();

  test('rewrites compound instructions and surfaces atomic steps + timer in cook mode', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');

    await createRecipeViaUi(page, {
      collectionTitle: 'Spice toasts',
      recipeTitle: 'Tempered Curry',
      ingredients: [
        { kind: 'measured', amount: '1', unit: 'teaspoon', name: 'cumin seeds' },
        { kind: 'measured', amount: '1', unit: 'teaspoon', name: 'coriander seeds' },
        { kind: 'vague', name: 'salt' },
      ],
      steps: [
        'Heat a large frying pan over medium-high heat, add the cumin seeds and coriander seeds, and dry-toast for about 2 minutes, shaking the pan until aromatic.',
      ],
    });

    // Read the freshly-created recipe + instruction ids from the on-page
    // Supabase client so we can seed a rewrite fixture that addresses
    // exactly this recipe.
    const ids = await page.evaluate(async () => {
      const sb = window.__cybSupabase;
      if (!sb) return null;
      // Wait for the outbox to flush our just-saved recipe.
      for (let i = 0; i < 30; i += 1) {
        const { data } = await sb
          .from('recipes')
          .select('id, instructions(id, step_number, text)')
          .eq('title', 'Tempered Curry')
          .limit(1);
        const row = data?.[0] as
          | { id: string; instructions?: Array<{ id: string; step_number: number; text: string }> }
          | undefined;
        if (row && row.instructions && row.instructions.length > 0) {
          return { recipeId: row.id, instructionId: row.instructions[0]!.id };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    });
    if (!ids) throw new Error('Could not resolve recipe ids');

    // Wildcard recipe id so we don't have to thread the live recipe id
    // through the worker mock — the worker probes (recipe_id, provider,
    // model) then ('*', provider, '') as the last fallback.
    await seedRewriteFixture({
      recipeId: '*',
      provider: 'gemini',
      model: '',
      upsert: true,
      rewritten: [
        {
          instructionId: ids.instructionId,
          simplifiedSteps: [
            { text: 'Heat a large frying pan over medium-high heat' },
            { text: 'Add the cumin and coriander seeds to the pan' },
            { text: 'Toast the seeds, shaking the pan, until aromatic', durationSec: 120 },
          ],
        },
      ],
    });

    await page.getByTestId('improve-instructions').click();

    // The page kicks the worker but the test env has no vault secret;
    // drive the worker by hand.
    await expect(page.getByTestId('rewrite-status')).toBeVisible({ timeout: 5_000 });
    await triggerWorker();

    // Wait for the rewrite to land via realtime → local-DB → React Query.
    await expect(page.getByTestId('simplified-preview')).toBeVisible({
      timeout: 30_000,
    });

    // Cook mode now has 3 simplified-step rows, the third with a timer.
    await page.getByRole('link', { name: 'Cook mode' }).click();
    const simplified = page.getByTestId('simplified-list');
    await expect(simplified).toBeVisible();
    await expect(simplified.getByRole('listitem')).toHaveCount(3);
    await expect(simplified.getByText('Toast the seeds, shaking the pan, until aromatic')).toBeVisible();
    await expect(page.getByTestId('timer-start')).toBeVisible();
    await expect(page.getByTestId('timer-start')).toContainText('2:00');

    // Click Start → switches to running state. We don't wait the full
    // 2 minutes; just check the running label appears.
    await page.getByTestId('timer-start').click();
    await expect(page.getByTestId('timer-running')).toBeVisible({ timeout: 5_000 });
  });
});
