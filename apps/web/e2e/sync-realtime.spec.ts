import { test, expect, signIn } from './support/fixtures.js';

test.describe('Local-first: realtime propagates across sessions', () => {
  test('a change in one tab appears in another tab for the same user', async ({
    authedPage: page,
    user,
    browser,
  }) => {
    await page.goto('/library');
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Realtime Source');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Realtime Source' })).toBeVisible();

    // Open a second browser context for the same user — a fresh IndexedDB
    // and independent Supabase session.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signIn(pageB, user);
    // The landing page is now the recipes gallery; the collection card
    // lives on the library grid.
    await pageB.goto('/library');
    await expect(pageB.getByText('Realtime Source')).toBeVisible();

    // We're already on the collection detail page in tab A after creation.
    // Toggling public generates an UPDATE row the realtime channel must
    // deliver to tab B. (There is no in-UI rename yet — using the public
    // toggle keeps this test focused on sync propagation.)
    await page.getByRole('button', { name: 'Make public' }).click();
    await page
      .getByRole('dialog', { name: /Publish .* to Discover\?/ })
      .getByRole('button', { name: 'I understand, publish' })
      .click();

    // The second tab should see the collection flip to public without manual
    // refresh. Allow generous time for realtime delivery.
    await expect(pageB.locator('li', { hasText: 'Realtime Source' }).getByText('Public')).toBeVisible({
      timeout: 15_000,
    });

    await ctxB.close();
  });
});
