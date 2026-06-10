import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi, openRecipeMoreMenu } from './support/helpers.js';
import { configureOcrKey, pumpWorker, seedRemixFixture } from './support/imports.js';

/**
 * End-to-end for Recipe Remix. Creates a recipe via the UI, seeds a
 * remix_test_fixtures row (the mock LLM "returns" a transformed recipe in
 * the OCR import schema), opens the Remix dialog, drives the worker by hand,
 * then verifies the preview → save flow produces a NEW recipe linked to the
 * original (parent_recipe_id) without touching the original, and that the
 * spend lands in the LLM Cost Center.
 *
 * The worker is in mock mode (OCR_MOCK_MODE=1), so the OCR API key value
 * doesn't matter.
 */

const SHEETPAN = {
  title: 'Sheet-Pan Beef Stew',
  yield: { type: 'exact', value: 4, unit: 'PEOPLE' },
  ingredients: [
    { type: 'measured', name: 'beef chuck', quantity: { type: 'exact', value: 500, unit: 'GRAM' } },
    { type: 'measured', name: 'potatoes', quantity: { type: 'exact', value: 4, unit: 'WHOLE' } },
    { type: 'vague', name: 'salt', description: 'to taste' },
  ],
  instructions: [
    { stepNumber: 1, text: 'Spread the beef and potatoes on a sheet pan.' },
    { stepNumber: 2, text: 'Roast at 220C for 40 minutes.' },
  ],
};

async function resolveRecipeId(page: import('@playwright/test').Page, title: string): Promise<string> {
  const id = await page.evaluate(async (t) => {
    const sb = window.__cybSupabase;
    if (!sb) return null;
    for (let i = 0; i < 30; i += 1) {
      const { data } = await sb.from('recipes').select('id').eq('title', t).limit(1);
      const row = data?.[0] as { id: string } | undefined;
      if (row) return row.id;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }, title);
  if (!id) throw new Error(`Could not resolve recipe id for "${title}"`);
  return id;
}

test.describe('Recipe Remix', () => {
  test.slow();

  test('remixes a recipe, iterates, and saves a new linked recipe', async ({ authedPage: page }) => {
    await configureOcrKey(page, 'gemini');

    await createRecipeViaUi(page, {
      collectionTitle: 'Weeknight dinners',
      recipeTitle: 'Beef Stew',
      ingredients: [
        { kind: 'measured', amount: '500', unit: 'gram', name: 'beef chuck' },
        { kind: 'measured', amount: '4', unit: 'piece', name: 'potatoes' },
        { kind: 'vague', name: 'salt' },
      ],
      steps: ['Brown the beef, add potatoes and water, and simmer for 2 hours until tender.'],
    });

    const sourceId = await resolveRecipeId(page, 'Beef Stew');

    // Wildcard recipe id so we don't have to thread the live id through the
    // mock — the worker probes (recipe_id, provider, model) then ('*', ...).
    await seedRemixFixture({
      recipeId: '*',
      provider: 'gemini',
      model: '',
      upsert: true,
      recipes: [SHEETPAN],
    });

    // Open the dialog (via the ⋯ More menu) and run the first remix turn.
    await openRecipeMoreMenu(page);
    await page.getByTestId('remix-open').click();
    await expect(page.getByTestId('remix-dialog')).toBeVisible();
    await page.getByTestId('remix-instruction').fill('make it a sheet-pan dinner');
    await page.getByTestId('remix-run').click();

    // The page kicks the worker but the test env has no vault secret; drive
    // the worker by hand (pumpWorker retries until the queued job is drained).
    await pumpWorker();
    await expect(page.getByTestId('remix-preview')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('remix-preview-title')).toHaveText(SHEETPAN.title);

    // Iterate: a chat follow-up runs a second turn against the working draft.
    await page.getByTestId('remix-followup').fill('and make it vegetarian');
    await page.getByTestId('remix-run').click();
    await pumpWorker();
    await expect(page.getByTestId('remix-turns').locator('li')).toHaveCount(2, { timeout: 30_000 });

    // Save → new recipe, navigates to it.
    await page.getByTestId('remix-save').click();
    await expect(page.getByRole('heading', { name: SHEETPAN.title })).toBeVisible({ timeout: 30_000 });

    // The new recipe is linked to the original, and the original is untouched.
    // The save is local-first; poll the server until the outbox push lands.
    const check = await page.evaluate(async ({ src }) => {
      const sb = window.__cybSupabase!;
      let derivedTitles: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        const derived = await sb
          .from('recipes')
          .select('id, title, parent_recipe_id')
          .eq('parent_recipe_id', src);
        derivedTitles = (derived.data ?? []).map((r: { title: string }) => r.title);
        if (derivedTitles.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const original = await sb
        .from('recipes')
        .select('id, title, instructions(id)')
        .eq('id', src)
        .maybeSingle();
      const remixUsage = await sb
        .from('llm_usage_report')
        .select('feature, succeeded')
        .eq('feature', 'remix');
      return {
        derivedTitles,
        originalTitle: (original.data as { title?: string } | null)?.title ?? null,
        originalSteps: ((original.data as { instructions?: unknown[] } | null)?.instructions ?? []).length,
        remixRows: (remixUsage.data ?? []).length,
      };
    }, { src: sourceId });

    expect(check.derivedTitles).toContain(SHEETPAN.title);
    // Original is unchanged: still "Beef Stew", still has its single step.
    expect(check.originalTitle).toBe('Beef Stew');
    expect(check.originalSteps).toBe(1);
    // Spend surfaced in the Cost Center (two turns → at least one remix row).
    expect(check.remixRows).toBeGreaterThanOrEqual(1);
  });

  test('surfaces a worker failure and creates no recipe', async ({ authedPage: page }) => {
    await configureOcrKey(page, 'gemini');
    await createRecipeViaUi(page, {
      collectionTitle: 'Failures',
      recipeTitle: 'Plain Toast',
      ingredients: [
        { kind: 'measured', amount: '2', unit: 'piece', name: 'bread slices' },
        { kind: 'vague', name: 'butter' },
      ],
      steps: ['Toast the bread and spread the butter.'],
    });
    const sourceId = await resolveRecipeId(page, 'Plain Toast');

    // Force the worker down the PARSE error path.
    await seedRemixFixture({ recipeId: '*', provider: 'gemini', model: '', errorKind: 'PARSE', upsert: true });

    await openRecipeMoreMenu(page);
    await page.getByTestId('remix-open').click();
    await page.getByTestId('remix-instruction').fill('make it fancy');
    await page.getByTestId('remix-run').click();
    await pumpWorker();

    // The turn shows a failed status; no preview / save appears.
    await expect(page.getByTestId('remix-turns').getByText('✗ Failed')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('remix-preview')).toHaveCount(0);
    await expect(page.getByTestId('remix-save')).toHaveCount(0);

    // No new recipe was created from this source.
    const derivedCount = await page.evaluate(async (src) => {
      const sb = window.__cybSupabase!;
      const { data } = await sb.from('recipes').select('id').eq('parent_recipe_id', src);
      return (data ?? []).length;
    }, sourceId);
    expect(derivedCount).toBe(0);
  });

  test('remix_start rejects a recipe the caller cannot read', async ({ authedPage: page }) => {
    // The read-gate (not an ownership gate) must still reject a recipe the
    // caller can't see. A random uuid is the cleanest "not readable" case.
    const result = await page.evaluate(async () => {
      const sb = window.__cybSupabase!;
      const { error } = await sb.rpc('remix_start', {
        p_recipe_id: '00000000-0000-0000-0000-000000000000',
        p_provider: 'gemini',
        p_model: 'gemini-2.5-flash',
        p_prompt: '',
        p_instruction: 'make it spicy',
        p_input_recipe_json: { title: 'x', ingredients: [], instructions: [] },
      });
      return { message: error?.message ?? null };
    });
    expect(result.message).toContain('not found or not readable');
  });
});
