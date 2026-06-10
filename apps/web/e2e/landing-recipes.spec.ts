import { test, expect } from './support/fixtures.js';

// The signed-in landing surface is the all-recipes gallery; the collections
// grid moved to /library (nav item + `g l` chord follow it).
test.describe('Default landing', () => {
  test('signed-in / lands on Recipes; Library lives at /library', async ({
    authedPage: page,
  }) => {
    // authedPage signs in and lands on `/` — the fixture already asserted
    // the Recipes heading. Double-check the URL is the root, not a redirect.
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Recipes', exact: true })).toBeVisible();

    // The Library nav item reaches the collections grid at /library.
    await page.getByRole('link', { name: 'Library', exact: true }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible();

    // `g r` goes home to Recipes, `g l` back to the Library.
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page).toHaveURL('/');
    await page.keyboard.press('g');
    await page.keyboard.press('l');
    await expect(page).toHaveURL(/\/library$/);
  });
});
