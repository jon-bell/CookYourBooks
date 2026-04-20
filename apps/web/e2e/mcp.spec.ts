import { test, expect } from './support/fixtures.js';

// These tests hit /api/mcp directly via fetch. In CI (production) the
// edge function reads env vars at runtime; under `vite preview` + the
// Playwright serve step, there's no serverless runtime, so we
// replicate the dispatcher logic against the already-running local
// Supabase. This keeps the coverage honest about the *tools* even
// while the HTTP transport is exercised separately in unit tests.
//
// The specs run inside the authenticated SPA so we already have an
// active `window.__cybSupabase` client scoped to the test user, which
// means we can mint a CLI token + hit the RPCs directly without
// re-implementing cookie/session plumbing here.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './support/env.js';

async function mintToken(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const sb = window.__cybSupabase;
    if (!sb) throw new Error('supabase client not available');
    const { data, error } = await sb.rpc('cli_issue_token', { token_name: 'mcp-e2e' });
    if (error) throw new Error(error.message ?? 'cli_issue_token failed');
    return data as string;
  });
}

async function callRpc<T>(
  page: import('@playwright/test').Page,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  return page.evaluate(
    async ({ url, anonKey, fn, args }) => {
      const resp = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(args),
      });
      if (!resp.ok) throw new Error(`${fn}: ${resp.status} ${await resp.text()}`);
      return await resp.json();
    },
    { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, fn, args },
  ) as Promise<T>;
}

test.describe('MCP-backed RPCs', () => {
  test('search + get_recipe + shopping CRUD round-trip through the token-gated RPCs', async ({
    authedPage: page,
  }) => {
    // Seed a collection + two recipes so searches have something to hit.
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('MCP Collection');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'MCP Collection' })).toBeVisible();

    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Sourdough Bread');
    await page.locator('input[placeholder="ingredient name"]').first().fill('flour');
    await page.locator('input[placeholder=amount]').first().fill('500');
    await page.locator('ol textarea').first().fill('Mix and bake.');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Sourdough Bread' })).toBeVisible();

    const token = await mintToken(page);

    // search_recipes (RPC: cli_search_recipes) — matches by title.
    const hits = await callRpc<Array<{ recipe_id: string; recipe_title: string }>>(
      page,
      'cli_search_recipes',
      { raw_token: token, query: 'sourdough' },
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits.find((h) => h.recipe_title === 'Sourdough Bread');
    expect(hit).toBeDefined();

    // get_recipe (RPC: cli_get_recipe) — full payload.
    const recipe = await callRpc<{
      title: string;
      ingredients: Array<{ name: string }>;
      collection_title: string;
    }>(page, 'cli_get_recipe', { raw_token: token, recipe_id: hit!.recipe_id });
    expect(recipe.title).toBe('Sourdough Bread');
    expect(recipe.collection_title).toBe('MCP Collection');
    expect(recipe.ingredients.map((i) => i.name)).toContain('flour');

    // add_shopping_item → list_shopping_items → check → remove.
    const added = await callRpc<{ id: string; name: string; checked: boolean }>(
      page,
      'cli_add_shopping',
      { raw_token: token, name: 'eggs', quantity_text: '1 dozen' },
    );
    expect(added.name).toBe('eggs');

    const listing = await callRpc<Array<{ id: string; name: string; checked: boolean }>>(
      page,
      'cli_list_shopping',
      { raw_token: token },
    );
    expect(listing.map((x) => x.name)).toContain('eggs');

    await callRpc(page, 'cli_check_shopping', {
      raw_token: token,
      item_id: added.id,
      checked: true,
    });
    const afterCheck = await callRpc<Array<{ id: string; checked: boolean }>>(
      page,
      'cli_list_shopping',
      { raw_token: token },
    );
    const eggs = afterCheck.find((x) => x.id === added.id)!;
    expect(eggs.checked).toBe(true);

    await callRpc(page, 'cli_remove_shopping', { raw_token: token, item_id: added.id });
    const afterRemove = await callRpc<Array<{ id: string }>>(page, 'cli_list_shopping', {
      raw_token: token,
    });
    expect(afterRemove.find((x) => x.id === added.id)).toBeUndefined();
  });

  test('anonymous callers cannot drive the RPCs without a valid token', async ({ page }) => {
    const resp = await page.evaluate(
      async ({ url, anonKey }) => {
        const r = await fetch(`${url}/rest/v1/rpc/cli_list_shopping`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw_token: 'cyb_cli_fakefake' }),
        });
        return { status: r.status, body: await r.text() };
      },
      { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY },
    );
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.body).toMatch(/Invalid CLI token/);
  });
});

test.describe('Pantry UI', () => {
  test('pantry items added in the UI appear in the list', async ({ authedPage: page }) => {
    await page.getByRole('link', { name: /Shopping/ }).click();
    await expect(page.getByTestId('pantry-section')).toBeVisible();

    await page.getByLabel('Pantry item').fill('whole milk');
    await page.getByLabel('Quantity').fill('1 gallon');
    await page.getByRole('button', { name: 'Add' }).click();

    await expect(
      page.getByTestId('pantry-section').getByText('whole milk', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByTestId('pantry-section').getByText('1 gallon'),
    ).toBeVisible();
  });
});
