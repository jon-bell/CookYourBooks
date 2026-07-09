import { adminGet } from './support/admin.js';
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { expect, signIn, test } from './support/fixtures.js';

// A valid 16×16 RGBA PNG. Must be a real, decodable image (not a 1×1 stub):
// the cover upload now decodes + re-encodes client-side, so an undecodable
// fixture would exercise the passthrough path instead of the resize path.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff61000001ec49444154789c15d2d11440210004d1871042082184104208212c420821841042082164b06ffabee7ccd77cdf27874f8e9f9c3e397f72f9e4fac9ed9385777ce0135ff8c60f7ef1ef0b7208720c720a720e7209720d720bb2f08e0f7ce20bdff8c16f7881288728c728a728e7289728d728b7280beff8c027bef08d1ffcc617487248724c724a724e7249724d724bb2f08e0f7ce20bdff8c16f7a812c872cc72ca72ce72c972cd72cb72c0beff8c027bef08d1ffce617287228722c722a722e7229722d722bb2f08e0f7ce20bdff8c16f79812a872ac72aa72ae72a972ad72ab72a0beff8c027bef08d1ffcd617687268726c726a726e7269726d726bb2f08e0f7ce20bdff8c16f7b01f181f8407c203e101f880fc407e203bce3039ff8c2377ef0ab17e87cd0f9a0f341e783ce079d0f3a1f743ec03b3ef0892f7ce307bffd05061f0c3e187c30f860f0c1e083c107830ff08e0f7ce20bdff8c1ef7881c907930f261f4c3e987c30f960f2c1e403bce3039ff8c2377ef03b5f60f1c1e283c5078b0f161f2c3e587cb0f800eff8c027bef08d1ffcae17d87cb0f960f3c1e683cd079b0f361f6c3ec03b3ef0892f7ce307bffb050e1f1c3e387c70f8e0f0c1e183c307870ff08e0f7ce20bdff8c1ef7981cb07970f2e1f5c3eb87c70f9e0f2c1e503bce3039ff8c2377ef08bff4e4b6f1fc115b8be0000000049454e44ae426082',
  'hex',
);

test.describe('Cover images', () => {
  test('upload, display, remove', async ({ authedPage: page }) => {
    await page.goto('/library');
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

    // The cover is re-encoded (WebP/JPEG, never the raw PNG we uploaded) and
    // stamped with the immutable long-cache header at a content-addressed key.
    const src = await img.getAttribute('src');
    expect(src).toMatch(/-[0-9a-f]{8}\.(webp|jpg)(\?|$)/);
    const head = await page.request.get(src!);
    expect(head.headers()['content-type']).toMatch(/image\/(webp|jpeg)/);
    expect(head.headers()['cache-control']).toContain('immutable');

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
    // Only the imported recipe gets content (children fold into JSON). Keep both
    // objects' keys uniform — PostgREST bulk insert rejects mismatched keys.
    await admin('recipes', [
      {
        id: importedId,
        collection_id: col!.id,
        title: 'Imported Dish',
        sort_order: 0,
        instructions: [{ id: crypto.randomUUID(), stepNumber: 1, text: 'Cook it.' }],
        has_content: true,
      },
      {
        id: placeholderId,
        collection_id: col!.id,
        title: 'Placeholder Dish',
        sort_order: 1,
        instructions: [],
        has_content: false,
      },
    ]);

    // Enqueue covers for the whole library, as the user (auth.uid() + claim).
    const enqueued = await page.evaluate(
      async ({ url, key }) => {
        const session = JSON.parse(
          localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('sb-')) ?? '') ??
            '{}',
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

  test('cover dialog keeps its tabs visible with a tall collage grid', async ({ page, user }) => {
    // Seed (service role) a collection with many covered recipes BEFORE sign-in
    // so the first full pull hydrates them into the local cache deterministically
    // (same trick as discover.spec relies on for owned rows).
    const admin = async (table: string, body: unknown) => {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`seed ${table} failed: ${resp.status} ${await resp.text()}`);
      return resp;
    };

    const colResp = await admin('recipe_collections', {
      owner_id: user.id,
      title: 'Big Cover Set',
      source_type: 'PERSONAL',
      is_public: false,
    });
    const [col] = (await colResp.json()) as { id: string }[];

    // 16 recipes each carrying a cover_image_path → the collage grid grows tall
    // enough to overflow the modal. Before the shrink-0 fix, the flex parent
    // compressed the tab strip and its `overflow-hidden` clipped the labels.
    const rows = Array.from({ length: 16 }, (_, i) => ({
      id: crypto.randomUUID(),
      collection_id: col!.id,
      title: `Covered ${i + 1}`,
      sort_order: i,
      cover_image_path: `${user.id}/covers/fake-${i}.webp`,
      instructions: [],
      has_content: false,
    }));
    await admin('recipes', rows);

    await signIn(page, user);
    await page.goto(`/collections/${col!.id}`);
    await expect(page.getByRole('heading', { name: 'Big Cover Set' })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Generate collection cover' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // The tall grid must have actually rendered (proves the squish scenario).
    await expect(dialog.locator('button[title="Covered 1"]')).toBeVisible();

    const collageTab = dialog.getByRole('tab', { name: 'Collage of recipe covers' });
    const aiTab = dialog.getByRole('tab', { name: 'AI from contents' });
    await expect(collageTab).toBeVisible();
    await expect(aiTab).toBeVisible();

    // The tab strip must not be vertically compressed: its buttons render at
    // ~32px (text-sm + py-1.5). A collapsed strip (the bug) drops well below this.
    const box = await collageTab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(28);

    // Both tabs still switch modes.
    await aiTab.click();
    await expect(dialog.getByText(/Gemini will design a cookbook cover/)).toBeVisible();
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
        const resp = await fetch(`${url}/storage/v1/object/covers/${notMyId}/covers/evil.png`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${token ?? ''}`,
            'Content-Type': 'image/png',
          },
          body: new Uint8Array([137, 80, 78, 71]),
        });
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
