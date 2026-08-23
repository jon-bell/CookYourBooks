import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { expect, test } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

// End-to-end proof that the capture path actually reaches Postgres: the RPC
// grant, the security-definer owner stamp, the client buffer's flush timer, and
// the query→open join all have to work for these rows to show up. The unit
// suite (src/signals/capture.test.ts) covers the buffering rules against a fake
// transport; only this spec exercises the real wire.

interface SearchEventRow {
  query_id: string;
  kind: 'query' | 'open';
  query: string;
  mode: string;
  result_count: number;
  opened_recipe_id: string | null;
  opened_rank: number | null;
  source_filter: string;
}

/** Read a user's rows with the service role — RLS is owner-only, so a test
 *  can't see them any other way. */
async function readSearchEvents(ownerId: string): Promise<SearchEventRow[]> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/search_events?owner_id=eq.${ownerId}` +
      `&select=query_id,kind,query,mode,result_count,opened_recipe_id,opened_rank,source_filter` +
      `&order=created_at.asc`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    },
  );
  if (!resp.ok) throw new Error(`read search_events ${resp.status}: ${await resp.text()}`);
  return (await resp.json()) as SearchEventRow[];
}

test.describe('Interaction signals', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    // Same rationale as search.spec.ts: keep the 30 MB model download out of
    // CI and exercise the deterministic substring path.
    await page.addInitScript(() => {
      (window as unknown as { __cybDisableEmbedder?: boolean }).__cybDisableEmbedder = true;
    });
    await createRecipeViaUi(page, {
      collectionTitle: 'Dinners',
      recipeTitle: 'Chicken Soup',
      ingredients: [{ kind: 'measured', amount: '1', unit: 'cup', name: 'stock' }],
      steps: ['Simmer.'],
    });
  });

  test('records the search and the result the user opens, joined by query_id', async ({
    authedPage: page,
    user,
  }) => {
    await page.locator('header').getByRole('link', { name: 'Search', exact: true }).click();
    await page.waitForURL(/\/search$/);
    await page.getByPlaceholder(/Search by recipe/).fill('chicken');
    await expect(page.getByText('Chicken Soup')).toBeVisible({ timeout: 5000 });
    await page.getByRole('link', { name: /Chicken Soup/ }).click();
    await expect(page.getByRole('heading', { name: 'Chicken Soup' })).toBeVisible();

    // Capture coalesces on a 4s timer, so poll rather than sleeping a fixed
    // amount — the click is client-side navigation and never fires pagehide.
    await expect
      .poll(async () => (await readSearchEvents(user.id)).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    const rows = await readSearchEvents(user.id);
    const query = rows.find((r) => r.kind === 'query' && r.query === 'chicken');
    const open = rows.find((r) => r.kind === 'open');
    expect(query).toBeTruthy();
    expect(query!.mode).toBe('substring');
    expect(query!.result_count).toBeGreaterThanOrEqual(1);
    expect(open).toBeTruthy();
    // The join is the whole point: without it the open row is unattributable.
    expect(open!.query_id).toBe(query!.query_id);
    expect(open!.opened_rank).toBe(0);
    expect(open!.opened_recipe_id).toBeTruthy();
  });

  test('records nothing after the user opts out in Settings', async ({
    authedPage: page,
    user,
  }) => {
    await page.goto('/settings/danger');
    const toggle = page.getByTestId('product-improvement-toggle');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();

    await page.goto('/search');
    await page.getByPlaceholder(/Search by recipe/).fill('chicken');
    await expect(page.getByText('Chicken Soup')).toBeVisible({ timeout: 5000 });
    await page.getByRole('link', { name: /Chicken Soup/ }).click();
    await expect(page.getByRole('heading', { name: 'Chicken Soup' })).toBeVisible();

    // Wait past the flush window, then assert the absence. Nothing was ever
    // enqueued, so there is nothing that could arrive late.
    await page.waitForTimeout(6_000);
    expect(await readSearchEvents(user.id)).toHaveLength(0);
  });
});
