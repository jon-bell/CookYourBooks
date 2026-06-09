import { test, expect, signIn, waitForSynced } from './support/fixtures.js';
import { createTestUser } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import {
  acceptTosViaService,
  cleanupHouseholdFor,
  householdRest,
  joinHouseholdViaInvite,
  listAuditLog,
  readInviteToken,
  seedHousehold,
  seedMembership,
} from './support/household.js';
import { createRecipeViaUi } from './support/helpers.js';

// All household tests share the same teardown pattern: tear down each
// test user we created, plus any household state we seeded. Tests use
// short-lived users created in the test body rather than the `user`
// fixture so we can attribute cleanup precisely.

test.describe('Household sharing', () => {
  test('owner creates household + invites a member + shares a collection', async ({
    browser,
  }) => {
    // Two browser contexts + full create / invite / accept / share / sync
    // round-trip blows past the default 30s.
    test.setTimeout(90_000);
    const owner = await createTestUser('hh-owner');
    const member = await createTestUser('hh-member');
    await acceptTosViaService(owner.id);
    await acceptTosViaService(member.id);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      // ---- Owner side: create household ----
      await signIn(pageA, owner);
      await pageA.goto('/household');
      await expect(
        pageA.getByRole('heading', { name: 'Household sharing' }),
      ).toBeVisible();
      await pageA.getByLabel('Household name').fill('Test Household');
      await pageA.getByRole('button', { name: 'Create household' }).click();
      await expect(
        pageA.getByRole('heading', { name: 'Test Household' }),
      ).toBeVisible();

      // Generate invite
      await pageA.getByRole('button', { name: 'Create invite link' }).click();
      const token = await readInviteToken(pageA);
      expect(token).toMatch(/^[a-f0-9]{48}$/);

      // ---- Owner side: create a collection and share it with the household ----
      await createRecipeViaUi(pageA, {
        collectionTitle: 'Family Recipes',
        recipeTitle: 'Sunday Pasta',
        ingredients: [{ kind: 'vague', name: 'pasta' }],
        steps: ['Boil water', 'Cook pasta'],
      });
      // Library sharing is on by default for household members, so the
      // collection is shared without any per-collection action — the
      // collection page just reflects that state.
      await pageA.getByRole('link', { name: /Family Recipes/ }).first().click();
      await expect(pageA.getByTestId('household-share-status')).toContainText(
        /Shared with Test Household/,
      );

      // ---- Member side: accept invite ----
      await joinHouseholdViaInvite(pageB, member, token);
      // /household page should show the member view
      await expect(
        pageB.getByRole('heading', { name: 'Test Household' }),
      ).toBeVisible();
      // Member sees the owner row in the member list.
      await expect(pageB.getByText(/OWNER · joined/)).toBeVisible({ timeout: 10_000 });

      // ---- Member side: the owner's whole library should appear ----
      await pageB.getByRole('link', { name: 'Library' }).click();
      await waitForSynced(pageB);
      // Trigger another sync — pull is async, and the owner's content
      // landed while pageB was on /household.
      await pageB.reload();
      await waitForSynced(pageB);
      await expect(pageB.getByText('Family Recipes')).toBeVisible({ timeout: 20_000 });

      // ---- Regression: a recipe added to an already-shared cookbook
      //      AFTER the member joined must also propagate (this is the bug
      //      the library model fixes). Owner adds a second recipe to
      //      Family Recipes; the member re-pulls and sees it.
      await pageA.getByRole('link', { name: 'Add recipe' }).click();
      await pageA.locator('main input').first().fill('Tuesday Tacos');
      await pageA.locator('input[placeholder="ingredient name"]').first().fill('tortilla');
      await pageA.locator('ol textarea').first().fill('Assemble and serve.');
      await pageA.getByRole('button', { name: 'Save recipe' }).click();
      await expect(pageA.getByRole('heading', { name: 'Tuesday Tacos' })).toBeVisible();
      await waitForSynced(pageA);

      await pageB.reload();
      await waitForSynced(pageB);
      await pageB.getByRole('link', { name: /Family Recipes/ }).first().click();
      await expect(pageB.getByText('Tuesday Tacos')).toBeVisible({ timeout: 20_000 });
    } finally {
      await cleanupHouseholdFor([owner.id, member.id]);
      await owner.cleanup();
      await member.cleanup();
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('household cap (6) is enforced on accept', async ({ browser }) => {
    const owner = await createTestUser('cap-owner');
    await acceptTosViaService(owner.id);
    // Create 5 already-existing members via service role to fill the cap.
    const fillers: { id: string; cleanup: () => Promise<void> }[] = [];
    for (let i = 0; i < 5; i += 1) {
      const u = await createTestUser(`cap-fill-${i}`);
      fillers.push(u);
    }
    const seventh = await createTestUser('cap-7th');
    await acceptTosViaService(seventh.id);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const { householdId } = await seedHousehold({
        ownerId: owner.id,
        name: 'Full House',
      });
      for (const m of fillers) {
        await seedMembership({ householdId, userId: m.id });
      }

      // Owner generates a real invite via UI for the 7th.
      await signIn(page, owner);
      await page.goto('/household');
      // Households at cap render a hint and the create-invite button is disabled.
      // We bypass the UI guard by issuing an invite via RPC (service role
      // can do this without going through the cap check at invite time —
      // the cap is enforced at *accept* time).
      const invite = (await householdRest<{ id: string; token: string }[]>(
        '/rest/v1/household_invites',
        {
          method: 'POST',
          body: {
            household_id: householdId,
            token: Array.from({ length: 48 }, () =>
              '0123456789abcdef'[Math.floor(Math.random() * 16)],
            ).join(''),
            created_by: owner.id,
            expires_at: new Date(Date.now() + 86400_000).toISOString(),
          },
        },
      ))[0]!;

      // Now the 7th member tries to accept — should fail with cap error.
      const userCtx = await browser.newContext();
      const userPage = await userCtx.newPage();
      try {
        await signIn(userPage, seventh);
        await userPage.goto(`/household/join?token=${invite.token}`);
        await userPage.getByRole('button', { name: 'Join household' }).click();
        await expect(
          userPage.getByText(/Household is full/),
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        await userCtx.close();
      }
    } finally {
      await cleanupHouseholdFor([owner.id, seventh.id, ...fillers.map((f) => f.id)]);
      await owner.cleanup();
      await seventh.cleanup();
      for (const f of fillers) await f.cleanup();
      await ctx.close();
    }
  });

  test('cooldown blocks re-joining after leaving', async ({ browser }) => {
    const owner = await createTestUser('cd-owner');
    const leaver = await createTestUser('cd-leaver');
    await acceptTosViaService(owner.id);
    await acceptTosViaService(leaver.id);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const { householdId } = await seedHousehold({
        ownerId: owner.id,
        name: 'Cooldown House',
      });
      await seedMembership({ householdId, userId: leaver.id });

      await signIn(page, leaver);
      await page.goto('/household');
      // Member view → click "Leave household"
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'Leave household' }).click();
      // Leaving invalidates + re-pulls the household/cooldown queries and runs a
      // sync pass; the no-household view + cooldown banner render off that
      // refreshed state. Wait for the sync to settle before asserting so the
      // banner check no longer races the leave round-trip at the default 5s.
      await waitForSynced(page);
      // After leaving, the page shows the no-household view.
      await expect(
        page.getByRole('heading', { name: 'Household sharing' }),
      ).toBeVisible();
      // And the cooldown banner is visible.
      await expect(page.getByText(/You recently left/)).toBeVisible();
      // Create-household button is disabled.
      await page.getByLabel('Household name').fill('Try Again');
      await expect(
        page.getByRole('button', { name: 'Create household' }),
      ).toBeDisabled();
    } finally {
      await cleanupHouseholdFor([owner.id, leaver.id]);
      await owner.cleanup();
      await leaver.cleanup();
      await ctx.close();
    }
  });

  test('public-flip on a household-shared collection requires fresh attestation', async ({
    browser,
  }) => {
    const owner = await createTestUser('pub-owner');
    await acceptTosViaService(owner.id);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const { householdId } = await seedHousehold({
        ownerId: owner.id,
        name: 'Pub House',
      });

      await signIn(page, owner);
      await createRecipeViaUi(page, {
        collectionTitle: 'Will Be Shared',
        recipeTitle: 'Bread',
        ingredients: [{ kind: 'vague', name: 'flour' }],
        steps: ['Mix', 'Bake'],
      });
      await page.getByRole('link', { name: /Will Be Shared/ }).first().click();
      // Library sharing is on by default, so this collection is already
      // household-shared (the public-flip cascade keys off that).
      await expect(page.getByTestId('household-share-status')).toContainText(/Shared with/);

      // Inspect collection id from URL.
      const url = page.url();
      const collectionId = url.match(/\/collections\/([0-9a-f-]{36})/)?.[1];
      expect(collectionId).toBeTruthy();

      // Wind last_share_attested_at back beyond the 5-minute cascade
      // window via service role to simulate the realistic "shared
      // hours ago, now trying to publish" case.
      await householdRest(
        `/rest/v1/recipe_collections?id=eq.${collectionId}`,
        {
          method: 'PATCH',
          body: { last_share_attested_at: new Date(Date.now() - 3600_000).toISOString() },
        },
      );

      // Attempt to flip is_public=true via service role. The trigger
      // runs regardless of auth.uid() and should reject with a clear
      // P0001. We expect the request to return 4xx (PostgREST surfaces
      // the trigger's RAISE as a 4xx error).
      const flipResp = await fetch(
        `${SUPABASE_URL}/rest/v1/recipe_collections?id=eq.${collectionId}`,
        {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ is_public: true }),
        },
      );
      expect(flipResp.ok).toBe(false);
      const errText = await flipResp.text();
      expect(errText).toMatch(/public attestation/i);

      // Confirm the underlying row didn't flip.
      const [row] = await householdRest<{ is_public: boolean }[]>(
        `/rest/v1/recipe_collections?id=eq.${collectionId}&select=is_public`,
      );
      expect(row?.is_public).toBe(false);

      // Calling attest_public_share via service role moves
      // last_share_attested_at to now() and lets a subsequent flip
      // through. The RPC requires auth.uid() so we can't actually call
      // it from service-role context — instead, just bump the
      // timestamp directly (mimics what the RPC would do under a real
      // session) and confirm the flip works.
      await householdRest(
        `/rest/v1/recipe_collections?id=eq.${collectionId}`,
        {
          method: 'PATCH',
          body: { last_share_attested_at: new Date().toISOString() },
        },
      );
      const flipOk = await fetch(
        `${SUPABASE_URL}/rest/v1/recipe_collections?id=eq.${collectionId}`,
        {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ is_public: true }),
        },
      );
      expect(flipOk.ok).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _hid = householdId;
    } finally {
      await cleanupHouseholdFor([owner.id]);
      await owner.cleanup();
      await ctx.close();
    }
  });

  test('audit log records library share + attestation entries', async ({ browser }) => {
    const owner = await createTestUser('audit-owner');
    await acceptTosViaService(owner.id);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, owner);
      await page.goto('/household');
      await page.getByLabel('Household name').fill('Audit House');
      await page.getByRole('button', { name: 'Create household' }).click();
      await expect(page.getByRole('heading', { name: 'Audit House' })).toBeVisible();

      // Library sharing defaults on. Toggle it off, then back on so the
      // one-time rights attestation is captured in the audit trail.
      page.once('dialog', (d) => d.accept());
      await page.getByTestId('library-sharing-disable').click();
      // The disable/enable toggle reflects household state re-pulled after the
      // mutation + sync pass; wait for sync so the button-swap assertions don't
      // race that round-trip at the default 5s timeout.
      await waitForSynced(page);
      await expect(page.getByTestId('library-sharing-enable')).toBeVisible();
      await page.getByTestId('library-sharing-enable').click();
      await page.getByTestId('library-attestation-checkbox').check();
      await page.getByTestId('library-sharing-confirm').click();
      await waitForSynced(page);
      await expect(page.getByTestId('library-sharing-disable')).toBeVisible();

      // Service-role view: confirm the audit-log entries exist.
      const created = await listAuditLog({ actorId: owner.id, action: 'HOUSEHOLD_CREATED' });
      expect(created.length).toBeGreaterThanOrEqual(1);
      const shared = await listAuditLog({ actorId: owner.id, action: 'LIBRARY_SHARED' });
      expect(shared.length).toBeGreaterThanOrEqual(1);
      const attest = await listAuditLog({ actorId: owner.id, action: 'ATTESTATION_GIVEN' });
      expect(attest.length).toBeGreaterThanOrEqual(1);
      // Attestation text is captured in metadata.
      const sample = attest.find((r) => (r.metadata as { attestation?: string }).attestation);
      expect(typeof (sample?.metadata as { attestation?: string }).attestation).toBe(
        'string',
      );

      // UI-side: the audit-log section on /household should also render rows.
      await page.goto('/household');
      await expect(page.getByTestId('audit-log')).toBeVisible();
      await expect(page.getByTestId('audit-row-HOUSEHOLD_CREATED')).toBeVisible();
      await expect(page.getByTestId('audit-row-LIBRARY_SHARED')).toBeVisible();
    } finally {
      await cleanupHouseholdFor([owner.id]);
      await owner.cleanup();
      await ctx.close();
    }
  });

  test('ToS gate appears before create-household for a user who has not accepted', async ({
    browser,
  }) => {
    const user = await createTestUser('tos-user'); // does NOT accept ToS in advance
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, user);
      await page.goto('/household');
      await page.getByLabel('Household name').fill('Gated House');
      await page.getByRole('button', { name: 'Create household' }).click();
      // The DB raises TOS_NOT_ACCEPTED, the dialog opens.
      await expect(
        page.getByRole('dialog', { name: /Accept Terms of Service/ }),
      ).toBeVisible();
      // Reject without checking the box — button stays disabled.
      await expect(page.getByTestId('tos-accept')).toBeDisabled();
      await page.getByTestId('tos-checkbox').check();
      await page.getByTestId('tos-accept').click();
      // After acceptance the dialog closes and the create-household form remains.
      // (We rely on the user re-clicking "Create household" — the gate's job
      // is to unblock, not to retry.)
      await expect(
        page.getByRole('dialog', { name: /Accept Terms of Service/ }),
      ).toBeHidden();
    } finally {
      await cleanupHouseholdFor([user.id]);
      await user.cleanup();
      await ctx.close();
    }
  });

  test('legal pages render without auth', async ({ page }) => {
    await page.goto('/legal');
    await expect(page.getByRole('heading', { name: 'Legal' })).toBeVisible();
    await page.getByRole('link', { name: 'Terms of Service' }).click();
    await expect(page.getByTestId('legal-terms')).toBeVisible();
    // The Terms page links to /legal/dmca but doesn't quote the
    // agent contact — that lives only on the DMCA page itself.
    await expect(page.getByText('cyb-dmca@copybyte.com')).toHaveCount(0);
    await page.goto('/legal/dmca');
    await expect(page.getByTestId('legal-dmca')).toBeVisible();
    // Registered Copyright Agent block (DMCA-1073402, CopyByte) is the
    // load-bearing thing on this page — assert against it specifically.
    await expect(page.getByText('Jonathan Bailey')).toBeVisible();
    await expect(page.getByText('cyb-dmca@copybyte.com')).toBeVisible();
  });
});
