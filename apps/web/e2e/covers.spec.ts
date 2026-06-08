import { test, expect } from './support/fixtures.js';
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { adminGet } from './support/admin.js';

// 1×1 transparent PNG, the smallest valid image the browser will render.
// hex → buffer.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d494441547801636060000000000005000157be1dd20000000049454e44ae426082',
  'hex',
);

test.describe('Cover images', () => {
  test('upload, display, remove', async ({ authedPage: page }) => {
    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Photo Shoot');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Photo Shoot' })).toBeVisible();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add cover' }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: 'cover.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    });

    // After upload, the button label flips to "Replace cover" and the <img>
    // references the Supabase Storage public URL.
    await expect(page.getByRole('button', { name: 'Replace cover' })).toBeVisible({
      timeout: 10_000,
    });
    const img = page.locator('img[alt="Cover"]');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute(
      'src',
      new RegExp(`${SUPABASE_URL.replace(/[/.]/g, '\\$&')}/storage/v1/object/public/covers/`),
    );

    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('button', { name: 'Add cover' })).toBeVisible();
  });

  test('bulk library generation skips not-yet-imported placeholders', async ({
    authedPage: page,
    user,
  }) => {
    // Seed (service role) a collection with one imported recipe (has a step)
    // and one placeholder (title only, no ingredients/instructions). The
    // recipes_set_owner trigger stamps owner_id from the collection.
    const admin = (table: string, body: unknown) =>
      fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(body),
      });

    const colResp = await admin('recipe_collections', {
      owner_id: user.id,
      title: 'Cover Scope',
      source_type: 'PERSONAL',
      is_public: false,
    });
    const [col] = (await colResp.json()) as { id: string }[];
    const importedId = crypto.randomUUID();
    const placeholderId = crypto.randomUUID();
    await admin('recipes', [
      { id: importedId, collection_id: col!.id, title: 'Imported Dish', sort_order: 0 },
      { id: placeholderId, collection_id: col!.id, title: 'Placeholder Dish', sort_order: 1 },
    ]);
    // Only the imported recipe gets content.
    await admin('instructions', [
      { id: crypto.randomUUID(), recipe_id: importedId, step_number: 1, text: 'Cook it.' },
    ]);

    // Enqueue covers for the whole library, as the user (auth.uid() + claim).
    const enqueued = await page.evaluate(
      async ({ url, key }) => {
        const session = JSON.parse(
          localStorage.getItem(
            Object.keys(localStorage).find((k) => k.startsWith('sb-')) ?? '',
          ) ?? '{}',
        );
        const token = session?.access_token as string | undefined;
        const resp = await fetch(`${url}/rest/v1/rpc/cover_jobs_enqueue`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${token ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_scope: 'library' }),
        });
        return { status: resp.status, count: await resp.json() };
      },
      { url: SUPABASE_URL, key: SUPABASE_ANON_KEY },
    );
    expect(enqueued.status).toBe(200);
    // Exactly one job — the placeholder was skipped.
    expect(enqueued.count).toBe(1);

    const jobs = await adminGet<{ recipe_id: string }[]>(
      `/rest/v1/recipe_cover_jobs?select=recipe_id&owner_id=eq.${user.id}`,
    );
    expect(jobs.map((j) => j.recipe_id)).toEqual([importedId]);
  });

  test('RLS blocks uploads into another user’s folder', async ({ authedPage: page, user }) => {
    // Drive the upload API directly from the page (so it carries the
    // authenticated session) and target a path that does NOT start with
    // the current user's id — the storage policy should say no.
    const result = await page.evaluate(
      async ({ url, key, notMyId }) => {
        const session = JSON.parse(
          localStorage.getItem('sb-127-auth-token') ??
            localStorage.getItem(
              Object.keys(localStorage).find((k) => k.startsWith('sb-')) ?? '',
            ) ??
            '{}',
        );
        const token = session?.access_token as string | undefined;
        const resp = await fetch(
          `${url}/storage/v1/object/covers/${notMyId}/covers/evil.png`,
          {
            method: 'POST',
            headers: {
              apikey: key,
              Authorization: `Bearer ${token ?? ''}`,
              'Content-Type': 'image/png',
            },
            body: new Uint8Array([137, 80, 78, 71]),
          },
        );
        return { status: resp.status };
      },
      {
        url: SUPABASE_URL,
        key: SUPABASE_ANON_KEY,
        notMyId: user.id.replace(/.$/, 'x'), // anything that's not our uid
      },
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });
});
