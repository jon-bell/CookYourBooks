import { adminGet, seedPublicCollection } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { expect, test } from './support/fixtures.js';

test.describe('Blocking authors (App Store Guideline 1.2)', () => {
  test('block hides every collection by that author, reports it, and is reversible', async ({
    authedPage: page,
    user,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const title = `Blockable ${tag}`;
    const siblingTitle = `Blockable sibling ${tag}`;
    const seed = await seedPublicCollection({ title, recipeTitles: ['Dubious Stew'] });
    // A second public collection by the same author: the block is per-author,
    // so this one must disappear too.
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/recipe_collections`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        owner_id: seed.ownerId,
        title: siblingTitle,
        source_type: 'PERSONAL',
        is_public: true,
      }),
    });
    expect(resp.ok).toBe(true);
    try {
      await page.getByRole('link', { name: 'Discover' }).click();
      const search = page.getByPlaceholder(/Search titles/);
      await search.fill(`Blockable`);
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByText(siblingTitle, { exact: true })).toBeVisible();

      await page.getByRole('button', { name: `Block the author of ${title}` }).click();
      const dialog = page.getByRole('dialog', { name: 'Block author' });
      await expect(dialog.getByText(/Block Test publisher\?/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Block', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      await expect(page.getByText(title, { exact: true })).toHaveCount(0);
      await expect(page.getByText(siblingTitle, { exact: true })).toHaveCount(0);

      // Moderation is notified via a USER report against the author.
      const reports = await adminGet<{ reporter_id: string; target_type: string }[]>(
        `/rest/v1/reports?select=reporter_id,target_type&target_id=eq.${seed.ownerId}`,
      );
      expect(reports).toContainEqual({ reporter_id: user.id, target_type: 'USER' });

      // Unblock from Settings → Data & deletion restores the author's content.
      await page.goto('/settings/danger');
      const section = page.getByTestId('blocked-users');
      await expect(section.getByText('Test publisher')).toBeVisible();
      await section.getByRole('button', { name: 'Unblock Test publisher' }).click();
      await expect(section.getByText("You haven't blocked anyone.")).toBeVisible();

      await page.goto('/discover');
      await page.getByPlaceholder(/Search titles/).fill('Blockable');
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByText(siblingTitle, { exact: true })).toBeVisible();
    } finally {
      await seed.cleanup();
    }
  });
});
