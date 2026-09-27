import { createTestUser, seedUserLibrary } from './support/admin.js';
import { expect, signIn, test, waitForSynced } from './support/fixtures.js';
import {
  acceptTosViaService,
  cleanupHouseholdFor,
  householdRest,
  seedHousehold,
  seedMembership,
} from './support/household.js';

// The local cache is per account. Regression for a shared-device leak: every
// account used one `cookyourbooks.db` that sign-out never cleared, so the next
// account to sign in saw the previous one's household-shared recipes (the
// gallery surfaces any row carrying the household marker).

test.describe('Local cache isolation', () => {
  test('a second account on the same device sees none of the first account’s cache', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const alice = await createTestUser('iso-alice');
    const coMember = await createTestUser('iso-comember');
    const bob = await createTestUser('iso-bob');
    await acceptTosViaService(alice.id);
    await acceptTosViaService(coMember.id);
    const { householdId } = await seedHousehold({ ownerId: coMember.id, name: 'Iso House' });
    await seedMembership({ householdId, userId: alice.id });
    await seedUserLibrary({
      ownerId: coMember.id,
      collectionTitle: 'Co-member Private Book',
      recipeCount: 2,
    });
    await seedUserLibrary({ ownerId: alice.id, collectionTitle: 'Alice Own Book', recipeCount: 1 });
    try {
      // Alice sees her own recipe and her co-member's shared ones.
      await signIn(page, alice);
      await expect(page.locator('main').getByText('Co-member Private Book').first()).toBeVisible({
        timeout: 20_000,
      });

      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.locator('header').getByRole('link', { name: 'Sign in' })).toBeVisible();

      // Bob, same browser profile: a different account signing in reloads the
      // page onto Bob's own database — an empty library, nothing of Alice's.
      await signIn(page, bob);
      await page.goto('/');
      await waitForSynced(page);
      await expect(page.getByText('Perf Recipe 1')).toHaveCount(0);
      await page.goto('/library');
      await waitForSynced(page);
      await expect(page.getByText('Co-member Private Book')).toHaveCount(0);
      await expect(page.getByText('Alice Own Book')).toHaveCount(0);

      // And Alice's cache is intact when she comes back (her own file).
      await page.goto('/');
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.locator('header').getByRole('link', { name: 'Sign in' })).toBeVisible();
      await signIn(page, alice);
      await page.goto('/library');
      await expect(page.locator('main').getByText('Alice Own Book')).toBeVisible();
    } finally {
      await cleanupHouseholdFor([alice.id, coMember.id]);
      await alice.cleanup();
      await coMember.cleanup();
      await bob.cleanup();
    }
  });

  test('a co-member who stops sharing disappears from the local cache', async ({ page }) => {
    test.setTimeout(120_000);
    const alice = await createTestUser('iso-viewer');
    const coMember = await createTestUser('iso-sharer');
    await acceptTosViaService(alice.id);
    await acceptTosViaService(coMember.id);
    const { householdId } = await seedHousehold({ ownerId: coMember.id, name: 'Iso House 2' });
    await seedMembership({ householdId, userId: alice.id });
    await seedUserLibrary({
      ownerId: coMember.id,
      collectionTitle: 'Soon Unshared Book',
      recipeCount: 1,
    });
    try {
      await signIn(page, alice);
      await page.goto('/library');
      await expect(page.locator('main').getByText('Soon Unshared Book')).toBeVisible({
        timeout: 20_000,
      });

      // The co-member turns library sharing off (service role — the RPC
      // path is covered by the household specs).
      await householdRest(
        `/rest/v1/household_members?household_id=eq.${householdId}&user_id=eq.${coMember.id}`,
        { method: 'PATCH', body: { library_shared: false } },
      );

      // The next sync evicts the cached copy.
      await page.reload();
      await waitForSynced(page);
      await page.goto('/library');
      await waitForSynced(page);
      await expect(page.getByText('Soon Unshared Book')).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await cleanupHouseholdFor([alice.id, coMember.id]);
      await alice.cleanup();
      await coMember.cleanup();
    }
  });
});
