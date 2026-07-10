import { expect, test, waitForSynced } from './support/fixtures.js';

/**
 * Favorite heart: toggled from the recipe page toolbar, surfaced on the
 * collection browser's cards/rows, filterable via the Favorites chip, and
 * persisted through the recipe save/sync path (survives a reload).
 */

async function seedRecipe(
  page: import('@playwright/test').Page,
  collection: string,
  title: string,
) {
  await page.goto('/library');
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(collection);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: collection })).toBeVisible();

  await page.getByRole('link', { name: 'Add recipe' }).click();
  await page.locator('main input').first().fill(title);
  const firstRow = page.locator('ul > li').first();
  await firstRow.locator('input[placeholder=amount]').fill('1');
  await firstRow.locator('input[placeholder="ingredient name"]').fill('water');
  await page.locator('ol textarea').first().fill('Boil.');
  await page.getByRole('button', { name: 'Save recipe' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await waitForSynced(page);
}

test.describe('Favorites', () => {
  test('heart toggles, filters, and survives a reload', async ({ authedPage: page }) => {
    await seedRecipe(page, 'Faves', 'Tea');

    // Toggle on from the recipe page toolbar.
    const heart = page.getByRole('button', { name: 'Favorite this recipe' });
    await heart.click();
    await expect(page.getByRole('button', { name: 'Remove favorite' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitForSynced(page);

    // The collection browser shows it, and the Favorites chip filters to it.
    await page.getByRole('link', { name: 'Faves' }).first().click();
    await expect(page.getByRole('heading', { name: 'Faves' })).toBeVisible();
    // Gallery card carries the pressed heart overlay.
    await expect(page.getByRole('button', { name: 'Remove Tea from favorites' })).toBeVisible();
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await expect(page.getByText('1 of 1 recipe')).toBeVisible();

    // Unfavorite straight from the card; the filtered view empties.
    await page.getByRole('button', { name: 'Remove Tea from favorites' }).click();
    await expect(page.getByText(/No favorites yet/)).toBeVisible();
    await waitForSynced(page);

    // Re-favorite and confirm persistence across a full reload.
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await page.getByRole('button', { name: 'Favorite Tea' }).click();
    await waitForSynced(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Faves' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Tea from favorites' })).toBeVisible();
  });
});
