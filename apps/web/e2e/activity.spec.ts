import { test, expect, signIn } from './support/fixtures.js';
import { createTestUser, type TestUser } from './support/admin.js';
import { createRecipeViaUi } from './support/helpers.js';
import { configureOcrKey, pumpWorker, seedRemixFixture } from './support/imports.js';
import { cleanupHouseholdFor, seedHousehold, seedMembership } from './support/household.js';
import type { Page } from '@playwright/test';

/**
 * End-to-end for the Activity page (/activity) — the unified background-jobs
 * feed. We drive real remix jobs (the cheapest job to provoke from the UI:
 * recipe-remix.spec.ts is the template) and assert they surface in-flight →
 * done, that owners can cancel/retry, and — critically — that the
 * batch_jobs_report view is RLS-scoped: a user sharing no household sees none
 * of another user's jobs, while a household co-member does (read-only).
 *
 * The worker runs in mock mode with no vault secret, so jobs stay queued until
 * pumpWorker() drains them by hand — which is exactly what lets us observe the
 * in-flight state.
 */

const REMIXED = {
  title: 'Activity Remixed Dish',
  yield: { type: 'exact', value: 4, unit: 'PEOPLE' },
  ingredients: [
    { type: 'measured', name: 'tofu', quantity: { type: 'exact', value: 400, unit: 'GRAM' } },
    { type: 'vague', name: 'soy sauce', description: 'to taste' },
  ],
  instructions: [{ stepNumber: 1, text: 'Press the tofu and pan-fry until golden.' }],
};

const SOURCE = {
  collectionTitle: 'Activity',
  recipeTitle: 'Activity Source',
  ingredients: [
    { kind: 'measured' as const, amount: '400', unit: 'gram', name: 'beef' },
    { kind: 'vague' as const, name: 'salt' },
  ],
  steps: ['Brown the beef and season to taste.'],
};

/** Open the Remix dialog and run one turn (creates a remix_jobs row). */
async function startRemix(page: Page, instruction: string): Promise<void> {
  await page.getByTestId('remix-open').click();
  await expect(page.getByTestId('remix-dialog')).toBeVisible();
  await page.getByTestId('remix-instruction').fill(instruction);
  await page.getByTestId('remix-run').click();
}

/** Block until at least one remix_jobs row exists for the signed-in user, so
 *  the first /activity fetch is guaranteed to see the in-flight job. */
async function waitForRemixJob(page: Page): Promise<void> {
  const ok = await page.evaluate(async () => {
    const sb = window.__cybSupabase;
    if (!sb) return false;
    for (let i = 0; i < 60; i += 1) {
      const { data } = await sb.from('remix_jobs').select('id').limit(1);
      if ((data ?? []).length > 0) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  });
  if (!ok) throw new Error('remix_jobs row never appeared');
}

test.describe('Activity feed', () => {
  test.slow();

  test('a remix job shows in progress, then done with a link to the recipe', async ({
    authedPage: page,
  }) => {
    await configureOcrKey(page, 'gemini');
    await createRecipeViaUi(page, SOURCE);
    await seedRemixFixture({ recipeId: '*', provider: 'gemini', model: '', upsert: true, recipes: [REMIXED] });

    await startRemix(page, 'make it vegetarian');
    await waitForRemixJob(page); // ensure the job exists before we navigate

    // In-flight: the worker hasn't been pumped, so the job is queued/running.
    await page.goto('/activity');
    const inflightRow = page.getByTestId('activity-inflight').getByTestId('activity-row-remix');
    await expect(inflightRow).toBeVisible({ timeout: 15_000 });
    await expect(inflightRow).toContainText('Recipe Remix');

    // Drain it. The in-flight row above already proved the live view; reload to
    // assert the terminal state deterministically rather than racing the poll.
    await pumpWorker();
    await page.reload();
    const recentRow = page.getByTestId('activity-recent').getByTestId('activity-row-remix');
    await expect(recentRow).toBeVisible({ timeout: 30_000 });
    await expect(recentRow).toContainText('Done');
    // Recipe-bound rows deep-link to the source recipe by its (locally-cached) title.
    await expect(recentRow.getByRole('link', { name: SOURCE.recipeTitle })).toBeVisible({ timeout: 15_000 });
  });

  test('owner can cancel a queued job', async ({ authedPage: page }) => {
    await configureOcrKey(page, 'gemini');
    await createRecipeViaUi(page, { ...SOURCE, collectionTitle: 'Cancel', recipeTitle: 'Cancel Source' });
    await seedRemixFixture({ recipeId: '*', provider: 'gemini', model: '', upsert: true, recipes: [REMIXED] });

    await startRemix(page, 'make it spicy');
    await waitForRemixJob(page);

    await page.goto('/activity');
    const inflightRow = page.getByTestId('activity-inflight').getByTestId('activity-row-remix');
    await expect(inflightRow).toBeVisible({ timeout: 15_000 });
    await inflightRow.getByTestId('activity-cancel').click();

    // Cancel flips it to FAILED ('CANCELLED'); it moves to Recent and the
    // cancel affordance disappears.
    const recentRow = page.getByTestId('activity-recent').getByTestId('activity-row-remix');
    await expect(recentRow).toContainText('Failed', { timeout: 15_000 });
    await expect(page.getByTestId('activity-cancel')).toHaveCount(0);
  });

  test('owner can retry a failed job', async ({ authedPage: page }) => {
    await configureOcrKey(page, 'gemini');
    await createRecipeViaUi(page, { ...SOURCE, collectionTitle: 'Retry', recipeTitle: 'Retry Source' });
    // First attempt fails (PARSE error path).
    await seedRemixFixture({ recipeId: '*', provider: 'gemini', model: '', errorKind: 'PARSE', upsert: true });

    await startRemix(page, 'make it gluten-free');
    await waitForRemixJob(page);
    await pumpWorker();

    await page.goto('/activity');
    const recentRow = page.getByTestId('activity-recent').getByTestId('activity-row-remix');
    await expect(recentRow).toContainText('Failed', { timeout: 30_000 });

    // Re-seed a success and retry; it re-queues (back to in-flight) and, after
    // a pump, lands DONE.
    await seedRemixFixture({ recipeId: '*', provider: 'gemini', model: '', upsert: true, recipes: [REMIXED] });
    await recentRow.getByTestId('activity-retry').click();
    // Wait for the reset to land (row back in-flight) before pumping, else the
    // pump runs against a still-FAILED row and is a no-op.
    await expect(
      page.getByTestId('activity-inflight').getByTestId('activity-row-remix'),
    ).toBeVisible({ timeout: 15_000 });
    await pumpWorker();
    await page.reload();
    await expect(
      page.getByTestId('activity-recent').getByTestId('activity-row-remix'),
    ).toContainText('Done', { timeout: 30_000 });
  });

  test('a non-household user sees none of another user\'s jobs (RLS boundary)', async ({
    authedPage: page,
    user: userA,
    browser,
  }) => {
    // User A queues a remix job.
    await configureOcrKey(page, 'gemini');
    await createRecipeViaUi(page, { ...SOURCE, collectionTitle: 'Private', recipeTitle: 'Private Source' });
    await seedRemixFixture({ recipeId: '*', provider: 'gemini', model: '', upsert: true, recipes: [REMIXED] });
    await startRemix(page, 'make it private');
    await waitForRemixJob(page);

    // User B shares no household with A.
    const userB = await createTestUser('rlsb');
    const ctxB = await browser.newContext();
    try {
      const pageB = await ctxB.newPage();
      await signIn(pageB, userB);
      await pageB.goto('/activity');

      // B's feed is empty…
      await expect(pageB.getByTestId('activity-empty')).toBeVisible({ timeout: 15_000 });
      // …and a direct read of the view returns none of A's rows.
      const probe = await pageB.evaluate(async () => {
        const sb = window.__cybSupabase!;
        const { data, error } = await sb.from('batch_jobs_report').select('owner_id, kind');
        return { rows: (data ?? []) as { owner_id: string }[], error: error?.message ?? null };
      });
      expect(probe.error).toBeNull();
      expect(probe.rows.some((r) => r.owner_id === userA.id)).toBe(false);
    } finally {
      await ctxB.close();
      await cleanupHouseholdFor([userB.id]);
      await userB.cleanup();
    }
  });

  test('a household co-member sees shared jobs, read-only', async ({
    authedPage: page,
    user: userA,
    browser,
  }) => {
    // A owns a household; B is a member. Both share their library by default.
    const userB = await createTestUser('hhb');
    const { householdId } = await seedHousehold({ ownerId: userA.id, name: 'Activity HH' });
    await seedMembership({ householdId, userId: userB.id });

    const ctxB = await browser.newContext();
    try {
      // A queues + completes a remix (its household_id is stamped because A is a
      // sharing member at insert time).
      await configureOcrKey(page, 'gemini');
      await createRecipeViaUi(page, { ...SOURCE, collectionTitle: 'Shared', recipeTitle: 'Shared Source' });
      await seedRemixFixture({ recipeId: '*', provider: 'gemini', model: '', upsert: true, recipes: [REMIXED] });
      await startRemix(page, 'make it a co-member can see');
      await waitForRemixJob(page);
      await pumpWorker();

      // B signs in (their JWT carries the household_id claim) and sees A's job.
      const pageB = await ctxB.newPage();
      await signIn(pageB, userB);
      await pageB.goto('/activity');
      const row = pageB.getByTestId('activity-row-remix');
      await expect(row).toBeVisible({ timeout: 20_000 });
      // It's attributed to A (not "You"), and is read-only for a co-member.
      await expect(row).not.toContainText('You');
      await expect(pageB.getByTestId('activity-cancel')).toHaveCount(0);
      await expect(pageB.getByTestId('activity-retry')).toHaveCount(0);
    } finally {
      await ctxB.close();
      await cleanupHouseholdFor([userA.id, userB.id]);
      await userB.cleanup();
    }
  });
});
