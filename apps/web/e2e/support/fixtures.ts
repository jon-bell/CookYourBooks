import { expect, type Page, test as base } from '@playwright/test';

import { createTestUser, type TestUser } from './admin.js';
import { setWorkerOwner } from './workerOwner.js';

/**
 * Sign in via the UI. Uses the real form so session storage, auth state,
 * and the SyncProvider's init flow are exercised on every test.
 */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  // `exact: true` avoids ambiguity with the "Sign in with Apple" /
  // "Sign in with Google" OAuth buttons that also live on this page.
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // After login the app lands on the all-recipes gallery at `/`, but
  // AllRecipesPage gates its "Recipes" heading behind `localReady` + the first
  // server pull — until then it renders only a "Loading…" placeholder (the
  // heading is not in the DOM yet). That first sync can exceed the default 5s
  // expect timeout under load, so the old ordering (assert heading, *then*
  // waitForSynced) raced it and flaked across every authedPage-based test.
  // Wait for the SyncProvider's own readiness signal first, then assert the
  // heading it unlocks.
  await waitForSynced(page);
  await expect(page.getByRole('heading', { name: 'Recipes', exact: true })).toBeVisible();
}

/** Wait until sync reaches the idle ('Synced') state. Polls the
 *  `data-sync-state` attribute (on the desktop header badge AND the mobile
 *  tab bar — both render at every viewport, one visible each) rather than
 *  badge text, since the header is hidden below the `md` breakpoint. */
export async function waitForSynced(page: Page): Promise<void> {
  await expect(page.locator('[data-sync-state]').first()).toHaveAttribute(
    'data-sync-state',
    'idle',
    { timeout: 15_000 },
  );
}

interface Fixtures {
  user: TestUser;
  authedPage: Page;
}

export const test = base.extend<Fixtures>({
  user: async ({}, use, testInfo) => {
    const tag = testInfo.title.replace(/[^a-z0-9]+/gi, '').slice(0, 16) || 'test';
    const u = await createTestUser(tag.toLowerCase());
    // Scope this test's worker pumps to its own user so it never drains another
    // (concurrent) test's jobs. Multi-user specs override per call.
    setWorkerOwner(u.id);
    await use(u);
    setWorkerOwner(null);
    await u.cleanup();
  },
  authedPage: async ({ page, user }, use) => {
    await signIn(page, user);
    await use(page);
  },
});

export { expect };
