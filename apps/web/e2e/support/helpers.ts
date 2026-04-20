import { expect, type Page } from '@playwright/test';
import { waitForSynced } from './fixtures.js';

/**
 * Build a collection + recipe through the UI. Returns when the new recipe
 * detail page is open and the save has been synced to the backend, so
 * dependent assertions start from a known, persisted state.
 */
export async function createRecipeViaUi(
  page: Page,
  opts: {
    collectionTitle: string;
    recipeTitle: string;
    servings?: { amount: string; description?: string };
    ingredients: Array<
      | { kind: 'measured'; amount: string; unit: string; name: string }
      | { kind: 'vague'; name: string }
    >;
    steps: string[];
  },
): Promise<void> {
  await page.goto('/');
  await waitForSynced(page);
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(opts.collectionTitle);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: opts.collectionTitle })).toBeVisible();

  await page.getByRole('link', { name: 'Add recipe' }).click();
  await page.locator('main input').first().fill(opts.recipeTitle);
  if (opts.servings) {
    await page.getByLabel('Servings').fill(opts.servings.amount);
    if (opts.servings.description) {
      await page.getByLabel('Description (optional)').fill(opts.servings.description);
    }
  }

  // Fill the initial empty row, adding new rows as needed.
  for (let i = 0; i < opts.ingredients.length; i += 1) {
    const row = opts.ingredients[i]!;
    if (i > 0) {
      await page.getByRole('button', { name: '+ Add ingredient' }).click();
    }
    const li = page.locator('section', { hasText: 'Ingredients' }).locator('ul > li').nth(i);
    if (row.kind === 'measured') {
      await li.locator('select').first().selectOption('MEASURED');
      await li.locator('input[placeholder=amount]').fill(row.amount);
      await li.locator('select').nth(1).selectOption(row.unit);
      await li.locator('input[placeholder="ingredient name"]').fill(row.name);
    } else {
      await li.locator('select').first().selectOption('VAGUE');
      await li.locator('input[placeholder="ingredient name"]').fill(row.name);
    }
  }

  for (let i = 0; i < opts.steps.length; i += 1) {
    if (i > 0) await page.getByRole('button', { name: '+ Add step' }).click();
    await page.locator('ol textarea').nth(i).fill(opts.steps[i]!);
  }

  await page.getByRole('button', { name: 'Save recipe' }).click();
  await expect(page.getByRole('heading', { name: opts.recipeTitle })).toBeVisible();
  await waitForSynced(page);
}
