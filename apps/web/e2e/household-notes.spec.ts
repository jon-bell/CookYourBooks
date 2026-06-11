import { createTestUser } from './support/admin.js';
import { expect, signIn, test, waitForSynced } from './support/fixtures.js';
import {
  acceptTosViaService,
  cleanupHouseholdFor,
  seedHousehold,
  seedMembership,
} from './support/household.js';

async function createCookbook(
  page: import('@playwright/test').Page,
  title: string,
): Promise<string> {
  await page.goto('/library');
  await waitForSynced(page);
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await waitForSynced(page);
  const m = new URL(page.url()).pathname.match(/\/collections\/([0-9a-f-]+)/);
  if (!m) throw new Error(`not on a collection page: ${page.url()}`);
  return m[1]!;
}

async function addNote(
  page: import('@playwright/test').Page,
  title: string,
  body: string,
): Promise<void> {
  await page.getByRole('button', { name: 'Add note' }).click();
  await page.getByLabel('Note title').fill(title);
  await page.getByLabel('Note text').fill(body);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await waitForSynced(page);
}

test.describe('Collection notes household sharing', () => {
  test("a co-member sees the owner's notes read-only; a non-member cannot", async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await createTestUser('note-owner');
    const member = await createTestUser('note-member');
    const stranger = await createTestUser('note-stranger');
    await acceptTosViaService(owner.id);
    await acceptTosViaService(member.id);
    await acceptTosViaService(stranger.id);
    const { householdId } = await seedHousehold({ ownerId: owner.id, name: 'Note House' });
    await seedMembership({ householdId, userId: member.id });

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    let collectionId: string;
    try {
      await signIn(pageA, owner);
      collectionId = await createCookbook(pageA, 'Shared Notes Cookbook');
      await addNote(pageA, 'House Rules', 'Always preheat the oven.');

      // Co-member (same household, library shared by default) reads it,
      // sees the shared badge, and has no edit/delete controls.
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      try {
        await signIn(pageB, member);
        await pageB.goto('/');
        await waitForSynced(pageB);
        await pageB.goto(`/collections/${collectionId}`);
        // Scope to the notes section so the collection-level "Delete" button
        // (collection delete) doesn't satisfy the read-only assertions.
        const notes = pageB.getByRole('region', { name: 'Collection notes' });
        await expect(notes.getByText('House Rules')).toBeVisible({ timeout: 15_000 });
        await expect(notes.getByText('Always preheat the oven.')).toBeVisible();
        await expect(notes.getByText('Shared by household')).toBeVisible();
        // Read-only for a co-member: the note card exposes no edit/delete controls.
        await expect(notes.getByRole('button', { name: 'Edit' })).toHaveCount(0);
        await expect(notes.getByRole('button', { name: 'Delete' })).toHaveCount(0);
      } finally {
        await ctxB.close();
      }

      // A non-member cannot read the note even at the direct collection URL
      // (RLS hides the collection + its notes from outside the household).
      const ctxC = await browser.newContext();
      const pageC = await ctxC.newPage();
      try {
        await signIn(pageC, stranger);
        await pageC.goto('/');
        await waitForSynced(pageC);
        await pageC.goto(`/collections/${collectionId}`);
        await expect(pageC.getByText('House Rules')).toHaveCount(0);
        await expect(pageC.getByText('Always preheat the oven.')).toHaveCount(0);
      } finally {
        await ctxC.close();
      }
    } finally {
      await cleanupHouseholdFor([owner.id, member.id]);
      await owner.cleanup();
      await member.cleanup();
      await stranger.cleanup();
      await ctxA.close();
    }
  });
});
