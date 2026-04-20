import { test as base, expect, type Page } from '@playwright/test';
import { createTestUser, type TestUser } from './admin.js';

/**
 * Sign in via the UI. Uses the real form so session storage, auth state,
 * and the SyncProvider's init flow are exercised on every test.
 */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // After login, the library page renders the heading. This also implicitly
  // waits for the SyncProvider's first pass to complete.
  await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible();
  await waitForSynced(page);
}

/** Wait until the sync badge reaches the 'Synced' state. */
export async function waitForSynced(page: Page): Promise<void> {
  await expect(page.locator('header button', { hasText: 'Synced' })).toBeVisible({
    timeout: 15_000,
  });
}

interface Fixtures {
  user: TestUser;
  authedPage: Page;
}

export const test = base.extend<Fixtures>({
  user: async ({}, use, testInfo) => {
    const tag = testInfo.title.replace(/[^a-z0-9]+/gi, '').slice(0, 16) || 'test';
    const u = await createTestUser(tag.toLowerCase());
    await use(u);
    await u.cleanup();
  },
  authedPage: async ({ page, user }, use) => {
    await signIn(page, user);
    await use(page);
  },
});

export { expect };
