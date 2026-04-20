import { test, expect, signIn } from './support/fixtures.js';
import { adminGet, createTestUser, seedPublicCollection } from './support/admin.js';

test.describe('Moderation: user reports and admin takedowns', () => {
  test('a regular user can report a public collection', async ({ page }) => {
    const seed = await seedPublicCollection({
      title: 'Reportable Collection',
      recipeTitles: ['Suspicious Recipe'],
    });
    const reporter = await createTestUser('reporter');
    try {
      await signIn(page, reporter);
      await page.getByRole('link', { name: 'Discover' }).click();
      await page.getByPlaceholder(/Search titles/).fill('Reportable Collection');
      await expect(page.getByText('Reportable Collection')).toBeVisible({ timeout: 10_000 });

      await page
        .getByRole('button', { name: /Report Reportable Collection/ })
        .click();
      await expect(page.getByRole('dialog', { name: /Report content/ })).toBeVisible();

      await page.getByLabel('Reason').selectOption('SPAM');
      await page.getByLabel('Details (optional)').fill('Looks like junk content.');
      await page.getByRole('button', { name: 'Submit report' }).click();

      await expect(page.getByText(/Thanks — an admin will review/)).toBeVisible();

      type R = Array<{
        reporter_id: string;
        target_type: string;
        target_id: string;
        reason: string;
        status: string;
        message: string | null;
      }>;
      const remote = await adminGet<R>(
        `/rest/v1/reports?select=*&target_id=eq.${seed.collectionId}`,
      );
      expect(remote.length).toBeGreaterThanOrEqual(1);
      const first = remote[0]!;
      expect(first.target_type).toBe('COLLECTION');
      expect(first.reason).toBe('SPAM');
      expect(first.status).toBe('OPEN');
      expect(first.reporter_id).toBe(reporter.id);
      expect(first.message).toBe('Looks like junk content.');
    } finally {
      await reporter.cleanup();
      await seed.cleanup();
    }
  });

  test('admin takedown removes the collection from Discover and writes an audit row', async ({
    page,
  }) => {
    // Use a unique title each run so stale seeds from a crashed prior
    // test don't produce duplicate matches.
    const title = `Takedown Target ${Math.random().toString(36).slice(2, 8)}`;
    const seed = await seedPublicCollection({
      title,
      recipeTitles: ['Bad Recipe'],
    });
    const admin = await createTestUser('modadmin', { admin: true });
    const reporter = await createTestUser('modreporter');

    try {
      // Step 1: reporter files a report so the admin queue has something.
      await signIn(page, reporter);
      await page.getByRole('link', { name: 'Discover' }).click();
      // Filter to the freshly seeded collection by id prefix so crashed
      // prior test runs (whose data hasn't been cleaned up yet) don't
      // resolve as duplicate matches.
      await page.getByPlaceholder(/Search titles/).fill(title);
      await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: `Report ${title}` }).click();
      await expect(page.getByRole('dialog', { name: /Report content/ })).toBeVisible();
      await page.getByLabel('Reason').selectOption('OFFENSIVE');
      await page.getByRole('button', { name: 'Submit report' }).click();
      await expect(page.getByText(/Thanks — an admin will review/)).toBeVisible();
      // Close the dialog explicitly — clicking "Close" only appears in the
      // success state and we're in it.
      await page.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(
        page.locator('header').getByRole('link', { name: 'Sign in' }),
      ).toBeVisible();

      // Step 2: admin signs in, opens the queue, and takes the collection down.
      await signIn(page, admin);
      await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole('link', { name: 'Admin' }).click();
      await expect(page.getByRole('heading', { name: 'Moderation' })).toBeVisible();
      await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });

      // The admin UI uses an in-app ReasonDialog — native browser prompts
      // were too crude for an audit-logged action.
      await page.getByRole('button', { name: 'Take down' }).first().click();
      const dialog = page.getByRole('dialog', { name: /Take the collection down/ });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/Reason/).fill('policy violation');
      await dialog.getByRole('button', { name: 'Take down' }).click();
      await expect(dialog).toBeHidden({ timeout: 10_000 });

      // The report flips from OPEN to ACTIONED, so the open queue now
      // excludes it.
      await expect(page.getByText(title)).toHaveCount(0, { timeout: 10_000 });

      // Step 3: verify server-side.
      type C = Array<{ is_public: boolean }>;
      const col = await adminGet<C>(
        `/rest/v1/recipe_collections?select=is_public&id=eq.${seed.collectionId}`,
      );
      expect(col[0]?.is_public).toBe(false);

      type M = Array<{ action: string; reason: string | null; target_id: string }>;
      const actions = await adminGet<M>(
        `/rest/v1/moderation_actions?select=action,reason,target_id&target_id=eq.${seed.collectionId}&order=created_at.desc`,
      );
      expect(actions[0]?.action).toBe('UNPUBLISH');
      expect(actions[0]?.reason).toBe('policy violation');

      // Step 4: the public Discover view no longer lists the collection.
      await page.getByRole('link', { name: 'Discover' }).click();
      await page.getByPlaceholder(/Search titles/).fill(title);
      await expect(page.getByText(/No public collections match/)).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await admin.cleanup();
      await reporter.cleanup();
      await seed.cleanup();
    }
  });

  test('non-admins are refused at /admin', async ({ authedPage: page }) => {
    await page.goto('/admin');
    await expect(page.getByText(/restricted to administrators/i)).toBeVisible();
  });

  test('a banned owner cannot re-publish their collection', async ({ page }) => {
    const admin = await createTestUser('banadmin', { admin: true });
    const victim = await createTestUser('victim');

    try {
      // Admin signs in and bans via the RPC (carried by the page's
      // authenticated supabase client).
      await signIn(page, admin);
      // The web app exposes its authenticated supabase client on
      // `window.__cybSupabase` for tests like this; hitting it through
      // the real client carries the signed-in session automatically and
      // works against both the Vite dev server and a production build.
      const banError = await page.evaluate(
        async ({ target }) => {
          const client = window.__cybSupabase;
          if (!client) throw new Error('window.__cybSupabase not set');
          const { error } = await client.rpc('moderation_ban_user', {
            target_user_id: target,
            reason: 'e2e',
          });
          return error?.message ?? null;
        },
        { target: victim.id },
      );
      expect(banError).toBeNull();

      // Confirm the ban landed in the profile row.
      type P = Array<{ disabled: boolean; disabled_reason: string | null }>;
      const profile = await adminGet<P>(
        `/rest/v1/profiles?select=disabled,disabled_reason&id=eq.${victim.id}`,
      );
      expect(profile[0]?.disabled).toBe(true);
      expect(profile[0]?.disabled_reason).toBe('e2e');

      // Directly call the RPC that would normally flip is_public via the
      // victim's session. The trigger should refuse with the standard
      // "This account is disabled" message — we assert on that rather than
      // try to coax the trigger error through the sync engine's UI path.
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(
        page.locator('header').getByRole('link', { name: 'Sign in' }),
      ).toBeVisible();
      await signIn(page, victim);

      await page.getByRole('link', { name: 'New collection' }).click();
      await page.getByLabel('Title').fill('Desperate Attempt');
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByRole('heading', { name: 'Desperate Attempt' })).toBeVisible();

      // Attempt the publish flip by calling the REST upsert directly with
      // the victim's session. The database trigger must reject it.
      const { status, body } = await page.evaluate(
        async ({ collectionTitle }) => {
          const client = window.__cybSupabase;
          if (!client) throw new Error('window.__cybSupabase not set');
          const { data } = await client
            .from('recipe_collections')
            .select('id')
            .eq('title', collectionTitle)
            .maybeSingle();
          if (!data?.id) return { status: 'no-id', body: '' };
          const { error } = await client
            .from('recipe_collections')
            .update({ is_public: true })
            .eq('id', data.id);
          return { status: error ? 'rejected' : 'accepted', body: error?.message ?? '' };
        },
        { collectionTitle: 'Desperate Attempt' },
      );
      expect(status).toBe('rejected');
      expect(body).toMatch(/disabled|cannot publish/i);

      // And remotely: is_public stays false.
      type C = Array<{ is_public: boolean }>;
      const rows = await adminGet<C>(
        `/rest/v1/recipe_collections?select=is_public&title=eq.Desperate%20Attempt`,
      );
      for (const r of rows) expect(r.is_public).toBe(false);
    } finally {
      await admin.cleanup();
      await victim.cleanup();
    }
  });
});
