import { test, expect, signIn, waitForSynced } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';
import { createTestUser } from './support/admin.js';

// Bare-uuid share links: /r/<recipeId> works for the owner (canonical
// redirect), anyone when the collection is public (including signed out),
// and shows a sign-in CTA otherwise. The share button's toast names the
// current audience.
test.describe('Recipe share links', () => {
  test('share toast reflects audience; anon access follows is_public; owner redirects; fork saves a copy', async ({
    authedPage: page,
    context,
    browser,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await createRecipeViaUi(page, {
      collectionTitle: 'Linkable Bakes',
      recipeTitle: 'Sourdough Focaccia',
      ingredients: [{ kind: 'vague', name: 'olive oil' }],
      steps: ['Dimple and bake.'],
    });
    const recipeUrl = page.url();
    const recipeId = recipeUrl.split('/recipes/')[1]!.split(/[/?#]/)[0]!;

    // Private collection → warn-tone reminder that only the owner can open it.
    await page.getByTestId('share-link-button').click();
    await expect(page.getByRole('status')).toContainText('only you can open this');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp(`/r/${recipeId}$`));

    // Signed-out visitor on a private recipe: unavailable card + sign-in CTA.
    const anonCtx1 = await browser.newContext();
    try {
      const anon = await anonCtx1.newPage();
      await anon.goto(`/r/${recipeId}`);
      await expect(anon.getByTestId('shared-recipe-unavailable')).toBeVisible();
      await expect(anon.getByRole('link', { name: 'Sign in to view' })).toBeVisible();
    } finally {
      await anonCtx1.close();
    }

    // Publish the collection (first publish goes through the DMCA dialog).
    await page.goto(`/collections/${recipeUrl.split('/collections/')[1]!.split('/')[0]}`);
    await page.getByRole('button', { name: 'Make public' }).click();
    await page
      .getByRole('dialog', { name: /Publish .* to Discover\?/ })
      .getByRole('button', { name: 'I understand, publish' })
      .click();
    await expect(page.getByRole('button', { name: 'Make private' })).toBeVisible();
    await waitForSynced(page);

    // Now the toast says anyone can view…
    await page.goto(recipeUrl);
    await expect(page.getByRole('heading', { name: 'Sourdough Focaccia' })).toBeVisible();
    await page.getByTestId('share-link-button').click();
    await expect(page.getByRole('status')).toContainText('anyone with the link');

    // …and a signed-out visitor can actually read it (read-only view, no
    // toolbar) and is offered sign-up-to-save.
    const anonCtx2 = await browser.newContext();
    try {
      const anon = await anonCtx2.newPage();
      await anon.goto(`/r/${recipeId}`);
      await expect(anon.getByTestId('shared-recipe-page')).toBeVisible();
      await expect(anon.getByRole('heading', { name: 'Sourdough Focaccia' })).toBeVisible();
      await expect(anon.getByText('olive oil')).toBeVisible();
      await expect(anon.getByText('Dimple and bake.')).toBeVisible();
      await expect(anon.getByRole('button', { name: 'Sign up to save this recipe' })).toBeVisible();
      // Owner-only chrome must not leak into the shared view.
      await expect(anon.getByRole('link', { name: 'Edit' })).toHaveCount(0);
      await expect(anon.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    } finally {
      await anonCtx2.close();
    }

    // The owner opening their own share link is redirected to the canonical
    // collection route with the full toolbar.
    await page.goto(`/r/${recipeId}`);
    await expect(page).toHaveURL(/\/collections\/[0-9a-f-]+\/recipes\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name: 'Sourdough Focaccia' })).toBeVisible();

    // A different signed-in user can fork the public recipe into an
    // auto-created "Saved recipes" collection.
    const visitor = await createTestUser('sharefork');
    const visitorCtx = await browser.newContext();
    try {
      const vp = await visitorCtx.newPage();
      await signIn(vp, visitor);
      await vp.goto(`/r/${recipeId}`);
      await expect(vp.getByTestId('shared-recipe-page')).toBeVisible();
      await vp.getByTestId('fork-to-library').click();
      await expect(vp).toHaveURL(/\/collections\/[0-9a-f-]+\/recipes\/[0-9a-f-]+$/, {
        timeout: 15_000,
      });
      await expect(vp.getByRole('heading', { name: 'Sourdough Focaccia' })).toBeVisible();
      await vp.goto('/library');
      await expect(vp.getByText('Saved recipes')).toBeVisible();
    } finally {
      await visitorCtx.close();
      await visitor.cleanup();
    }
  });
});
