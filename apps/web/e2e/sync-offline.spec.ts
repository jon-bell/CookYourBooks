import { test, expect, waitForSynced } from './support/fixtures.js';
import { adminGet } from './support/admin.js';

test.describe('Local-first: offline writes flush on reconnect', () => {
  test('queued create survives a reconnect and lands remotely', async ({
    authedPage: page,
    context,
    user,
  }) => {
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Offline Box');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Offline Box' })).toBeVisible();
    await waitForSynced(page);

    // Block Supabase specifically. `context.setOffline(true)` also tears down
    // the Vite dev server's WebSocket, breaking the app itself — we only want
    // the *backend* to be unreachable.
    await context.route('**/127.0.0.1:54421/**', (r) => r.abort());

    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Disconnected Dish');
    await page.locator('input[placeholder="ingredient name"]').first().fill('cheese');
    await page.locator('ol textarea').first().fill('Eat it.');
    await page.getByRole('button', { name: 'Save recipe' }).click();

    await expect(page.getByRole('heading', { name: 'Disconnected Dish' })).toBeVisible();
    // Wait for the in-flight cycle to finish (either 'Sync error' or 'Synced
    // · N queued' — both final, non-syncing states). If we dispatch the
    // online event too early it coalesces into the still-running cycle.
    await expect(page.locator('header button[title]')).toContainText(
      /Sync error|queued/,
      { timeout: 15_000 },
    );

    await context.unroute('**/127.0.0.1:54421/**');
    // Reconnection: the production app relies on the browser's 'online' event
    // (or a user-driven click) to kick a fresh cycle. In this Playwright
    // harness we can't toggle navigator.onLine without breaking Vite, so we
    // dispatch the event directly.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect(page.locator('header button[title]')).toHaveText(/Synced/, {
      timeout: 30_000,
    });
    await expect(page.locator('header button[title]')).not.toContainText(/queued/);

    type R = { title: string; collection_id: string }[];
    const remote = await adminGet<R>(
      `/rest/v1/recipes?select=title,collection_id&title=eq.Disconnected%20Dish`,
    );
    expect(remote.length).toBeGreaterThanOrEqual(1);
    const cols = await adminGet<{ id: string; owner_id: string }[]>(
      `/rest/v1/recipe_collections?select=id,owner_id&owner_id=eq.${user.id}`,
    );
    const myIds = new Set(cols.map((c) => c.id));
    expect(remote.some((r) => myIds.has(r.collection_id))).toBe(true);
  });

  test('local reads work without the network', async ({ authedPage: page, context }) => {
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Cache Me');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Cache Me' })).toBeVisible();
    await waitForSynced(page);

    await context.route('**/127.0.0.1:54421/**', (r) => r.abort());
    await page.getByRole('link', { name: 'Library' }).click();
    await expect(page.getByText('Cache Me')).toBeVisible();
    await page.getByText('Cache Me').click();
    await expect(page.getByRole('heading', { name: 'Cache Me' })).toBeVisible();
  });
});
