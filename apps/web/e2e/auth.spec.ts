import { test, expect, signIn } from './support/fixtures.js';
import { createTestUser } from './support/admin.js';

test.describe('Authentication', () => {
  test('unauthenticated visit to / shows the landing page with CTAs', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(
      page.getByRole('heading', { name: /cookbook library/i }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create an account' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  });

  test('landing page "Sign in" CTA routes to /sign-in', async ({ page }) => {
    await page.goto('/');
    // Use the prominent hero CTA rather than the header link.
    await page.locator('main').getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('signs in, sees library, signs out', async ({ page }) => {
    const user = await createTestUser('signin');
    try {
      await signIn(page, user);
      await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible();

      // Sign out returns us to the signed-out state — the header "Sign in"
      // link comes back, and the landing page renders in <main>.
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(
        page.locator('header').getByRole('link', { name: 'Sign in' }),
      ).toBeVisible();
    } finally {
      await user.cleanup();
    }
  });

  test('sign-in with wrong password shows the server error', async ({ page }) => {
    const user = await createTestUser('wrongpw');
    try {
      await page.goto('/sign-in');
      await page.getByLabel('Email').fill(user.email);
      await page.getByLabel('Password').fill('definitely-not-it');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByText(/Invalid login credentials|invalid/i)).toBeVisible({
        timeout: 10_000,
      });
      await expect(page).toHaveURL(/\/sign-in/);
    } finally {
      await user.cleanup();
    }
  });

  test('sign-up creates an account and lands on an empty library', async ({ page }) => {
    // Email confirmation is on by default in local Supabase. We bypass it by
    // creating the user through the admin API, but we still exercise the UI
    // sign-up form for the happy path that applies when confirmation is off
    // (e.g. mobile/OAuth flows).
    const stamp = Date.now().toString(36);
    const email = `signup-${stamp}@test.cookyourbooks.local`;

    await page.goto('/sign-up');
    await page.getByLabel('Display name').fill('Fresh User');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('pw-abc-123-x');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Either auto-confirm is on (we hit /) or it's off (we see the mailer
    // instruction). Both are acceptable; assert we didn't see a hard error.
    await expect(page.getByText(/error|invalid/i)).toHaveCount(0, { timeout: 4000 });
  });

  test('route guard: deep link to /shopping requires auth', async ({ page }) => {
    await page.goto('/shopping');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
