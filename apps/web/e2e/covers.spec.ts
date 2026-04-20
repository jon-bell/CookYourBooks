import { test, expect } from './support/fixtures.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './support/env.js';

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
