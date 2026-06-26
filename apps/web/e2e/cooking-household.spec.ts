import { createTestUser } from './support/admin.js';
import { expect, signIn, test, waitForSynced } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';
import {
  acceptTosViaService,
  cleanupHouseholdFor,
  householdRest,
  seedHousehold,
  seedMembership,
} from './support/household.js';

test.describe('Cooking tracker household sharing', () => {
  test('a co-member sees cooks only while the owner shares their library', async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await createTestUser('ck-owner');
    const member = await createTestUser('ck-member');
    await acceptTosViaService(owner.id);
    await acceptTosViaService(member.id);
    const { householdId } = await seedHousehold({ ownerId: owner.id, name: 'Cook House' });
    await seedMembership({ householdId, userId: member.id });

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    try {
      // Owner logs a cook.
      await signIn(pageA, owner);
      await createRecipeViaUi(pageA, {
        collectionTitle: 'Shared Kitchen',
        recipeTitle: 'Shared Stew',
        ingredients: [{ kind: 'vague', name: 'beans' }],
        steps: ['Simmer.'],
      });
      await pageA.getByTestId('i-made-this').click();
      await pageA.getByTestId('cook-submit').click();
      await expect(pageA.getByTestId('cooking-history').getByText(/History \(1\)/)).toBeVisible();
      await waitForSynced(pageA);

      // Member (same household, owner library shared by default) sees it.
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      await signIn(pageB, member);
      await pageB.goto('/cooking');
      await expect(pageB.getByTestId('calendar-day-detail').getByText('Shared Stew')).toBeVisible({
        timeout: 15_000,
      });
      await ctxB.close();

      // Owner turns library sharing off.
      await householdRest(
        `/rest/v1/household_members?household_id=eq.${householdId}&user_id=eq.${owner.id}`,
        { method: 'PATCH', body: { library_shared: false } },
      );

      // A FRESH member context (clean local cache) no longer sees the cook —
      // RLS hides the owner's rows once the library is unshared.
      const ctxC = await browser.newContext();
      const pageC = await ctxC.newPage();
      await signIn(pageC, member);
      await pageC.goto('/cooking');
      await expect(
        pageC.getByTestId('calendar-day-detail').getByText('Nothing cooked or planned'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(pageC.getByTestId('calendar-day-detail').getByText('Shared Stew')).toHaveCount(
        0,
      );
      await ctxC.close();
    } finally {
      await cleanupHouseholdFor([owner.id, member.id]);
      await owner.cleanup();
      await member.cleanup();
      await ctxA.close();
    }
  });

  test("a non-member cannot see another user's cooks", async ({ authedPage: page, browser }) => {
    test.setTimeout(90_000);
    const stranger = await createTestUser('ck-stranger');
    await acceptTosViaService(stranger.id);

    // The signed-in fixture user logs a cook in their own (unshared) library.
    await createRecipeViaUi(page, {
      collectionTitle: 'Private Kitchen',
      recipeTitle: 'Secret Sauce',
      ingredients: [{ kind: 'vague', name: 'mystery' }],
      steps: ['Stir.'],
    });
    await page.getByTestId('i-made-this').click();
    await page.getByTestId('cook-submit').click();
    await expect(page.getByTestId('cooking-history').getByText(/History \(1\)/)).toBeVisible();
    await waitForSynced(page);

    // An unrelated user sees nothing of it.
    const ctx = await browser.newContext();
    const strangerPage = await ctx.newPage();
    try {
      await signIn(strangerPage, stranger);
      await strangerPage.goto('/cooking');
      await expect(
        strangerPage.getByTestId('calendar-day-detail').getByText('Secret Sauce'),
      ).toHaveCount(0);
    } finally {
      await stranger.cleanup();
      await ctx.close();
    }
  });
});
