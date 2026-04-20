import { test, expect } from './support/fixtures.js';

test.describe('Sharing + social preview', () => {
  test('landing page ships with OG + Twitter Card tags', async ({ page }) => {
    await page.goto('/');
    // Don't assume a specific anon/authed render — check <head>.
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /CookYourBooks/,
    );
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute(
      'content',
      'website',
    );
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      /\/api\/og-image\?/,
    );
  });

  test('Copy link button appears only when a collection is public', async ({
    authedPage: page,
    context,
  }) => {
    // Headless Chromium needs explicit clipboard permission granted to
    // the origin — otherwise `navigator.clipboard.writeText` rejects
    // and we'd be exercising only the fallback.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Public Bakery');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Public Bakery' })).toBeVisible();

    // Private by default — the Copy link button shouldn't render yet.
    await expect(page.getByTestId('copy-link-button')).toHaveCount(0);

    // Flip it public.
    await page.getByRole('button', { name: 'Make public' }).click();
    await expect(page.getByRole('button', { name: 'Make private' })).toBeVisible();

    const copyBtn = page.getByTestId('copy-link-button');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(copyBtn).toHaveText('Copied!');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toMatch(/\/collections\/[0-9a-f-]{36}$/);
  });
});
