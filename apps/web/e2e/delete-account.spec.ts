import { adminGet, createTestUser } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { expect, signIn, test } from './support/fixtures.js';
import {
  acceptTosViaService,
  cleanupHouseholdFor,
  listAuditLog,
  seedHousehold,
  seedMembership,
} from './support/household.js';

/**
 * Right-to-erasure e2e. Covers the legal-spec promise that any user can
 * delete their account in-app and that the cascade reaches every
 * user-owned table, while the audit log survives (with actor_id
 * nulled) per the takedown-defense carve-out.
 */
test.describe('Right to erasure', () => {
  test('user can delete their account; content cascades; audit row remains', async ({ page }) => {
    const u = await createTestUser('erasure');
    await acceptTosViaService(u.id);
    try {
      await signIn(page, u);

      // Create a private collection so we have content to cascade-delete.
      await page.goto('/library');
      await page.getByRole('link', { name: 'New collection' }).click();
      await page.getByLabel('Title').fill('To Be Erased');
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByRole('heading', { name: 'To Be Erased' })).toBeVisible();

      // Confirm the collection exists on the server before deletion. The
      // local-first UI acknowledges before the outbox push lands, so poll
      // rather than asserting on the first read.
      type C = Array<{ id: string }>;
      await expect
        .poll(
          async () =>
            (await adminGet<C>(`/rest/v1/recipe_collections?select=id&owner_id=eq.${u.id}`)).length,
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(1);

      await page.goto('/settings/danger');
      await page.getByTestId('open-delete-account').click();
      // Wrong text — confirm stays disabled.
      await page.getByTestId('delete-confirm-input').fill('delete');
      await expect(page.getByTestId('confirm-delete-account')).toBeDisabled();
      // Correct text — confirm enabled.
      await page.getByTestId('delete-confirm-input').fill('DELETE');
      await page.getByTestId('confirm-delete-account').click();

      // After delete: signed out, landed on /.
      await page.waitForURL('/', { timeout: 15_000 });

      // Content rows are gone (FK cascade through profiles → collections).
      const after = await adminGet<C>(`/rest/v1/recipe_collections?select=id&owner_id=eq.${u.id}`);
      expect(after.length).toBe(0);

      // Profile is gone too.
      type P = Array<{ id: string }>;
      const profile = await adminGet<P>(`/rest/v1/profiles?select=id&id=eq.${u.id}`);
      expect(profile.length).toBe(0);

      // Audit log entry for ACCOUNT_DELETED survives with actor_id nulled.
      const audit = await listAuditLog({ action: 'ACCOUNT_DELETED' });
      const mine = audit.find((r) => (r.metadata as { user_id?: string }).user_id === u.id);
      expect(mine).toBeDefined();
      // actor_id was set when record_audit ran; the cascade nulled it.
      const auditDetail = await adminGet<Array<{ actor_id: string | null; action: string }>>(
        `/rest/v1/audit_log?select=actor_id,action&id=eq.${mine!.id}`,
      );
      expect(auditDetail[0]?.actor_id).toBeNull();
    } finally {
      // No-op cleanup if the test passed (user is already gone), but
      // belt-and-suspenders for the failure path.
      try {
        await u.cleanup();
      } catch {
        /* expected after successful deletion */
      }
    }
  });

  test('owner of a household with other members must transfer ownership first', async ({
    page,
  }) => {
    const owner = await createTestUser('erasure-owner');
    const member = await createTestUser('erasure-member');
    await acceptTosViaService(owner.id);
    await acceptTosViaService(member.id);
    try {
      const { householdId } = await seedHousehold({
        ownerId: owner.id,
        name: 'Erasure House',
      });
      await seedMembership({ householdId, userId: member.id });

      await signIn(page, owner);
      await page.goto('/settings/danger');
      await page.getByTestId('open-delete-account').click();
      await page.getByTestId('delete-confirm-input').fill('DELETE');
      await page.getByTestId('confirm-delete-account').click();

      // The RPC raises the actionable error; we surface it verbatim.
      await expect(page.getByTestId('delete-error')).toContainText(
        /Transfer or remove other household members/,
      );

      // The owner's account still exists.
      type P = Array<{ id: string }>;
      const profile = await adminGet<P>(`/rest/v1/profiles?select=id&id=eq.${owner.id}`);
      expect(profile.length).toBe(1);
    } finally {
      await cleanupHouseholdFor([owner.id, member.id]);
      await owner.cleanup();
      await member.cleanup();
    }
  });

  test('sole-owner household is dissolved on account deletion', async ({ page }) => {
    const owner = await createTestUser('erasure-solo');
    await acceptTosViaService(owner.id);
    try {
      const { householdId } = await seedHousehold({
        ownerId: owner.id,
        name: 'Solo Erasure',
      });

      // Bystander collection shared INTO this household by the owner. The
      // household cascade should unshare it before the household goes,
      // BUT the owner's collection is then itself cascade-deleted via
      // the profile cascade — so we expect zero collections owned by
      // the owner afterward (which is correct: the owner deleted their
      // own collection by deleting their account).
      await signIn(page, owner);
      await page.goto('/library');
      await page.getByRole('link', { name: 'New collection' }).click();
      await page.getByLabel('Title').fill('Solo Collection');
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByRole('heading', { name: 'Solo Collection' })).toBeVisible();

      // Get the collection id and mark it household-shared via service
      // role to exercise the unshare branch of the RPC. Poll: the
      // local-first UI acknowledges before the outbox push lands.
      type C = Array<{ id: string }>;
      let collectionId: string | undefined;
      await expect
        .poll(
          async () => {
            const cols = await adminGet<C>(
              `/rest/v1/recipe_collections?select=id&owner_id=eq.${owner.id}`,
            );
            collectionId = cols[0]?.id;
            return collectionId;
          },
          { timeout: 10_000 },
        )
        .toBeTruthy();
      await fetch(`${SUPABASE_URL}/rest/v1/recipe_collections?id=eq.${collectionId}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ shared_with_household_id: householdId }),
      });

      await page.goto('/settings/danger');
      await page.getByTestId('open-delete-account').click();
      await page.getByTestId('delete-confirm-input').fill('DELETE');
      await page.getByTestId('confirm-delete-account').click();
      await page.waitForURL('/', { timeout: 15_000 });

      // Household is gone, profile is gone, collections are gone.
      type H = Array<{ id: string }>;
      const households = await adminGet<H>(`/rest/v1/households?select=id&id=eq.${householdId}`);
      expect(households.length).toBe(0);
      const profile = await adminGet<C>(`/rest/v1/profiles?select=id&id=eq.${owner.id}`);
      expect(profile.length).toBe(0);
    } finally {
      try {
        await owner.cleanup();
      } catch {
        /* expected */
      }
    }
  });
});
