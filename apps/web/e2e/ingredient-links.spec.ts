import { expect, test, waitForSynced } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Ingredient → recipe cross-reference links', () => {
  test('auto-links a same-collection component, skips cross-collection, unlinks', async ({
    authedPage: page,
  }) => {
    // Book B has a "Secret Sauce" recipe — same NAME as an ingredient in Book A
    // below, but a DIFFERENT collection, so it must never auto-link.
    await createRecipeViaUi(page, {
      collectionTitle: 'Book B',
      recipeTitle: 'Secret Sauce',
      ingredients: [{ kind: 'vague', name: 'secrets' }],
      steps: ['Mix the secrets.'],
    });

    // Book A has the real component "Pizza Dough".
    await createRecipeViaUi(page, {
      collectionTitle: 'Book A',
      recipeTitle: 'Pizza Dough',
      ingredients: [{ kind: 'measured', amount: '3', unit: 'cup', name: 'flour' }],
      steps: ['Knead and rest.'],
    });

    // Add "Pizza" to Book A, using "Pizza Dough" (same book → links) and
    // "Secret Sauce" (only in Book B → must NOT link).
    await page.goto('/library');
    await waitForSynced(page);
    await page.getByRole('link', { name: 'Book A' }).first().click();
    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Pizza');
    const list = page.locator('section', { hasText: 'Ingredients' }).locator('ul > li');
    const row0 = list.nth(0);
    await row0.locator('select').first().selectOption('MEASURED');
    await row0.locator('input[placeholder=amount]').fill('1');
    await row0.locator('select').nth(1).selectOption('cup');
    await row0.locator('input[placeholder="ingredient name"]').fill('Pizza Dough');
    await page.getByRole('button', { name: '+ Add ingredient' }).click();
    const row1 = list.nth(1);
    await row1.locator('select').first().selectOption('VAGUE');
    await row1.locator('input[placeholder="ingredient name"]').fill('Secret Sauce');
    await page.locator('ol textarea').first().fill('Assemble and bake.');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await waitForSynced(page);
    await expect(page.getByRole('heading', { name: 'Pizza' })).toBeVisible();

    // The same-collection component auto-links (fire-and-forget pass + query
    // invalidation). "Secret Sauce" stays plain, so exactly one link exists.
    const link = page.getByTestId('ingredient-link');
    await expect(link).toHaveCount(1, { timeout: 15000 });
    await expect(link).toHaveText(/Pizza Dough/);
    // Let the auto-link push fully drain so a mid-edit sync pull can't re-seed
    // the editor form and clobber the unlink below.
    await waitForSynced(page);

    // The link navigates to the component recipe.
    await link.click();
    await expect(page.getByRole('heading', { name: 'Pizza Dough' })).toBeVisible();

    // Edit Pizza and unlink the component.
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Pizza' })).toBeVisible();
    await page.getByRole('link', { name: 'Edit' }).click();
    await expect(page.getByText('🔗 Linked to a recipe')).toBeVisible();
    await page.getByRole('button', { name: 'Unlink' }).click();
    // Confirm the unlink registered in the form before saving.
    await expect(page.getByText('Auto-linking off for this ingredient')).toBeVisible();
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await waitForSynced(page);
    await expect(page.getByRole('heading', { name: 'Pizza' })).toBeVisible();

    // The dismissal sticks — no link now, and it survives a reload (the
    // 'dismissed' marker persists and isn't re-auto-linked).
    await expect(page.getByTestId('ingredient-link')).toHaveCount(0, { timeout: 10000 });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Pizza' })).toBeVisible();
    await expect(page.getByTestId('ingredient-link')).toHaveCount(0);
  });

  test('manually links an ingredient to a recipe in another book', async ({ authedPage: page }) => {
    // A component recipe in one book…
    await createRecipeViaUi(page, {
      collectionTitle: 'Bakery',
      recipeTitle: 'Brioche Dough',
      ingredients: [{ kind: 'measured', amount: '2', unit: 'cup', name: 'flour' }],
      steps: ['Mix and proof.'],
    });
    // …referenced by a recipe in a DIFFERENT book, so it does NOT auto-link.
    await createRecipeViaUi(page, {
      collectionTitle: 'Sandwiches',
      recipeTitle: 'Fancy Toast',
      ingredients: [{ kind: 'measured', amount: '2', unit: 'cup', name: 'brioche' }],
      steps: ['Toast it.'],
    });
    await expect(page.getByRole('heading', { name: 'Fancy Toast' })).toBeVisible();
    await expect(page.getByTestId('ingredient-link')).toHaveCount(0);

    // Manually link "brioche" → the cross-book "Brioche Dough" via the picker.
    await page.getByRole('link', { name: 'Edit' }).click();
    await page.getByRole('button', { name: /Link to a recipe/ }).click();
    await page.getByTestId('link-picker-query').fill('Brioche Dough');
    await page.getByTestId('link-picker-pick').first().click();
    await expect(page.getByText('🔗 Linked to a recipe')).toBeVisible();
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await waitForSynced(page);
    await expect(page.getByRole('heading', { name: 'Fancy Toast' })).toBeVisible();

    // The manual link renders and navigates across books.
    const link = page.getByTestId('ingredient-link');
    await expect(link).toHaveCount(1, { timeout: 15000 });
    await expect(link).toHaveText(/brioche/i);
    await link.click();
    await expect(page.getByRole('heading', { name: 'Brioche Dough' })).toBeVisible();
  });
});
