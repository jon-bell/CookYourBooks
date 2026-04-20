import { test, expect } from './support/fixtures.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './support/env.js';

test.describe('CLI tokens', () => {
  test('user mints a token, uses it to drive RPCs, revokes it', async ({ authedPage: page }) => {
    // 1. Create a collection so there's something to export.
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('CLI Fixture');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'CLI Fixture' })).toBeVisible();

    // 2. Mint the token through the Settings UI. The raw string appears
    //    once inside the success panel — we capture it by reading the
    //    rendered `<code>` block.
    await page.goto('/settings');
    await page.getByLabel(/New token label/).fill('e2e');
    await page.getByRole('button', { name: 'Create token' }).click();
    await expect(
      page.getByText(/Copy it now — you won't see it again/),
    ).toBeVisible();
    const rawToken = (await page.locator('code', { hasText: /^cyb_cli_/ }).textContent()) ?? '';
    expect(rawToken).toMatch(/^cyb_cli_[0-9a-f]{48}$/);

    // 3. Exercise the token. Run from inside the page so it inherits the
    //    live Supabase URL and anon key baked into the bundle.
    const exportResult = await page.evaluate(
      async ({ url, anonKey, rawToken }) => {
        const resp = await fetch(`${url}/rest/v1/rpc/cli_export_library`, {
          method: 'POST',
          headers: {
            apikey: anonKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ raw_token: rawToken }),
        });
        return { status: resp.status, body: await resp.json() };
      },
      { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, rawToken },
    );
    expect(exportResult.status).toBe(200);
    expect(Array.isArray(exportResult.body.collections)).toBe(true);
    const titles = exportResult.body.collections.map((c: { title: string }) => c.title);
    expect(titles).toContain('CLI Fixture');

    // 4. Import a recipe through the same RPC path.
    const importResult = await page.evaluate(
      async ({ url, anonKey, rawToken }) => {
        const resp = await fetch(`${url}/rest/v1/rpc/cli_import_recipe`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            raw_token: rawToken,
            target_collection_id: null,
            recipe: {
              title: 'CLI Imported Dish',
              ingredients: [{ type: 'VAGUE', name: 'water' }],
              instructions: [{ step_number: 1, text: 'Boil.' }],
            },
          }),
        });
        return { status: resp.status, body: await resp.text() };
      },
      { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, rawToken },
    );
    expect(importResult.status).toBe(200);
    // Returns a UUID string (JSON-encoded).
    expect(importResult.body).toMatch(/^"[0-9a-f-]{36}"$/);

    // 5. Revoke via the UI. Accept the native confirm dialog.
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText(/No CLI tokens yet/)).toBeVisible();

    // 6. Token no longer works.
    const postRevoke = await page.evaluate(
      async ({ url, anonKey, rawToken }) => {
        const resp = await fetch(`${url}/rest/v1/rpc/cli_export_library`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw_token: rawToken }),
        });
        return { status: resp.status, body: await resp.text() };
      },
      { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, rawToken },
    );
    expect(postRevoke.status).toBeGreaterThanOrEqual(400);
    expect(postRevoke.body).toMatch(/Invalid CLI token/);
  });

  test('ToC export lists titles; ToC import seeds placeholders', async ({ authedPage: page }) => {
    // Seed: one collection with one existing recipe so we can assert
    // append-style sort ordering after import.
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('ToC Fixture');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'ToC Fixture' })).toBeVisible();

    // Grab the collection id out of the URL (…/collections/:id).
    const collectionId = page.url().split('/').pop() ?? '';
    expect(collectionId).toMatch(/^[0-9a-f-]{36}$/);

    // Mint a CLI token (the UI path is exercised in the test above, so
    // here we just issue one via the in-page supabase client).
    const rawToken = await page.evaluate(async () => {
      const sb = window.__cybSupabase;
      const { data, error } = await sb.rpc('cli_issue_token', { token_name: 'toc-e2e' });
      if (error) throw error;
      return data as string;
    });

    // Export the ToC — should surface the collection but zero recipes
    // (we never added any to ToC Fixture).
    const initialToc = await page.evaluate(
      async ({ url, anonKey, rawToken, collectionId }) => {
        const resp = await fetch(`${url}/rest/v1/rpc/cli_export_toc`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw_token: rawToken, collection_id: collectionId }),
        });
        return { status: resp.status, body: await resp.json() };
      },
      { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, rawToken, collectionId },
    );
    expect(initialToc.status).toBe(200);
    expect(initialToc.body.collections).toHaveLength(1);
    expect(initialToc.body.collections[0].title).toBe('ToC Fixture');
    expect(initialToc.body.collections[0].recipes).toEqual([]);

    // Import a list of titles.
    const imported = await page.evaluate(
      async ({ url, anonKey, rawToken, collectionId }) => {
        const resp = await fetch(`${url}/rest/v1/rpc/cli_import_toc`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            raw_token: rawToken,
            target_collection_id: collectionId,
            titles: ['Sourdough Loaf', 'Rye Starter', 'Focaccia'],
          }),
        });
        return { status: resp.status, body: await resp.json() };
      },
      { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, rawToken, collectionId },
    );
    expect(imported.status).toBe(200);
    expect(Array.isArray(imported.body)).toBe(true);
    expect(imported.body).toHaveLength(3);

    // Re-exporting shows the new placeholders, in order.
    const afterToc = await page.evaluate(
      async ({ url, anonKey, rawToken, collectionId }) => {
        const resp = await fetch(`${url}/rest/v1/rpc/cli_export_toc`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw_token: rawToken, collection_id: collectionId }),
        });
        return await resp.json();
      },
      { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, rawToken, collectionId },
    );
    const titles = (afterToc.collections[0].recipes as { title: string }[]).map((r) => r.title);
    expect(titles).toEqual(['Sourdough Loaf', 'Rye Starter', 'Focaccia']);
  });

  test('an anonymous caller cannot issue tokens', async ({ page }) => {
    // Hit the issue RPC directly without signing in — should 401.
    const resp = await page.evaluate(
      async ({ url, anonKey }) => {
        const r = await fetch(`${url}/rest/v1/rpc/cli_issue_token`, {
          method: 'POST',
          headers: { apikey: anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token_name: 'should fail' }),
        });
        return { status: r.status, body: await r.text() };
      },
      { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY },
    );
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.body).toMatch(/Sign in required/);
  });
});
