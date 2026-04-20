import { test, expect } from './support/fixtures.js';

test.describe('Collections', () => {
  test('creates a personal collection and it appears in the library', async ({ authedPage: page }) => {
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Weeknight Dinners');
    await page.getByLabel('Description').fill('Quick things for Tuesdays');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByRole('heading', { name: 'Weeknight Dinners' })).toBeVisible();
    await page.getByRole('link', { name: 'Library' }).click();
    await expect(page.getByText('Weeknight Dinners')).toBeVisible();
  });

  test('creates a cookbook with author metadata', async ({ authedPage: page }) => {
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Type').selectOption('PUBLISHED_BOOK');
    await page.getByLabel('Title').fill('Salt Fat Acid Heat');
    await page.getByLabel('Author').fill('Samin Nosrat');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByRole('heading', { name: 'Salt Fat Acid Heat' })).toBeVisible();
    await expect(page.getByText(/Cookbook · Samin Nosrat/)).toBeVisible();
  });

  test('creates a web collection with a source URL', async ({ authedPage: page }) => {
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Type').selectOption('WEBSITE');
    await page.getByLabel('Title').fill('Serious Eats picks');
    await page.getByLabel('Source URL').fill('https://seriouseats.com/');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByRole('heading', { name: 'Serious Eats picks' })).toBeVisible();
  });

  test('makes a collection public then private and the badge updates', async ({
    authedPage: page,
  }) => {
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Greens');
    await page.getByRole('button', { name: 'Create' }).click();

    await page.getByRole('button', { name: 'Make public' }).click();
    // The local save renders immediately, but a subsequent pull round-trip
    // can briefly echo the server's pre-toggle row back before settling.
    // Give the toggle long enough to stabilise.
    await expect(page.getByRole('button', { name: 'Make private' })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('link', { name: 'Library' }).click();
    await expect(
      page.locator('li', { hasText: 'Greens' }).getByText('Public'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('deletes a collection (with confirm accept) and it leaves the library', async ({
    authedPage: page,
  }) => {
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Temporary');
    await page.getByRole('button', { name: 'Create' }).click();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete collection' }).click();

    // Navigation happens inside the mutation's onSuccess, which also
    // invalidates the collections query — but the invalidation is async.
    // Assert against the final UI rather than an instantaneous snapshot.
    await page.waitForURL('/');
    await expect(page.locator('main').getByText('Temporary')).toHaveCount(0, {
      timeout: 10_000,
    });
  });
});
