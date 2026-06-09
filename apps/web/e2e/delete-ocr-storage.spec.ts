import { test, expect, signIn } from './support/fixtures.js';
import { adminGet, createTestUser } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';

/**
 * Right-to-delete-uploaded-images. The three scopes the user spec calls
 * out: a single item, every item in a batch, and every item across
 * every batch. The recipes promoted from these items must survive each
 * scope.
 */

// Drop a tiny payload directly into the `imports` bucket via the
// service-role REST API. Bypasses the bucket's per-user folder policy
// (admin role); we still write under `<user_id>/...` so the user's
// own DELETE RLS lets them clean it up later.
async function uploadFakeImage(userId: string, path: string): Promise<void> {
  const fullPath = `${userId}/${path}`;
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/imports/${fullPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true',
    },
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  });
  if (!resp.ok) {
    throw new Error(`upload ${fullPath}: ${resp.status} ${await resp.text()}`);
  }
}

async function bucketObjectExists(userId: string, path: string): Promise<boolean> {
  const fullPath = `${userId}/${path}`;
  const resp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/imports/${fullPath}`,
    { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` } },
  );
  return resp.ok;
}

// REST helper for the import_batches / import_items tables. Each batch
// gets the user as owner; items reference the batch. We populate
// storage_path with the path we just uploaded.
async function seedBatchWithItems(opts: {
  userId: string;
  batchName: string;
  paths: string[];
}): Promise<{ batchId: string; itemIds: string[] }> {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  const batchResp = await fetch(`${SUPABASE_URL}/rest/v1/import_batches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      owner_id: opts.userId,
      name: opts.batchName,
      source_kind: 'IMAGES',
      default_model: 'gemini-1.5-flash',
      default_provider: 'gemini',
      total_items: opts.paths.length,
    }),
  });
  const [batch] = (await batchResp.json()) as { id: string }[];
  const itemIds: string[] = [];
  for (let i = 0; i < opts.paths.length; i += 1) {
    const itemResp = await fetch(`${SUPABASE_URL}/rest/v1/import_items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        batch_id: batch!.id,
        owner_id: opts.userId,
        page_index: i,
        storage_path: `${opts.userId}/${opts.paths[i]}`,
        status: 'OCR_DONE',
      }),
    });
    const [item] = (await itemResp.json()) as { id: string }[];
    itemIds.push(item!.id);
  }
  return { batchId: batch!.id, itemIds };
}

test.describe('OCR uploaded-image deletion', () => {
  test('per-item: clears the one item, leaves the others intact', async ({ page }) => {
    const u = await createTestUser('ocr-del-item');
    try {
      await uploadFakeImage(u.id, 'a.jpg');
      await uploadFakeImage(u.id, 'b.jpg');
      const { itemIds } = await seedBatchWithItems({
        userId: u.id,
        batchName: 'Per Item Batch',
        paths: ['a.jpg', 'b.jpg'],
      });

      await signIn(page, u);
      // Drive the RPC + storage delete via the in-page supabase client.
      // `await import('/src/...')` works under `pnpm dev` (Vite serves
      // TS source) but breaks under `vite preview` (production build,
      // no TS files in the dist). Inline the same call sequence the
      // helper makes so CI's preview-server setup matches dev.
      const removed = await page.evaluate(async (itemId) => {
        const client = window.__cybSupabase!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: paths, error } = await (client as any).rpc(
          'clear_my_import_storage',
          { p_scope: 'item', p_id: itemId },
        );
        if (error) throw new Error(error.message);
        const list = (paths as string[]) ?? [];
        if (list.length === 0) return 0;
        const { error: storageError } = await client.storage
          .from('imports')
          .remove(list);
        if (storageError) throw new Error(storageError.message);
        return list.length;
      }, itemIds[0]!);
      expect(removed).toBeGreaterThanOrEqual(1);

      expect(await bucketObjectExists(u.id, 'a.jpg')).toBe(false);
      expect(await bucketObjectExists(u.id, 'b.jpg')).toBe(true);

      type R = Array<{ id: string; storage_path: string }>;
      const items = await adminGet<R>(
        `/rest/v1/import_items?select=id,storage_path&owner_id=eq.${u.id}&order=page_index`,
      );
      expect(items[0]?.storage_path).toBe('');
      expect(items[1]?.storage_path).toBe(`${u.id}/b.jpg`);
    } finally {
      await u.cleanup();
    }
  });

  test('per-batch: clears every item in the batch; other batches untouched', async ({
    page,
  }) => {
    const u = await createTestUser('ocr-del-batch');
    try {
      await uploadFakeImage(u.id, 'b1-a.jpg');
      await uploadFakeImage(u.id, 'b1-b.jpg');
      await uploadFakeImage(u.id, 'b2-a.jpg');
      const { batchId: b1 } = await seedBatchWithItems({
        userId: u.id,
        batchName: 'Batch 1',
        paths: ['b1-a.jpg', 'b1-b.jpg'],
      });
      await seedBatchWithItems({
        userId: u.id,
        batchName: 'Batch 2',
        paths: ['b2-a.jpg'],
      });

      await signIn(page, u);
      await page.evaluate(async (batchId) => {
        const client = window.__cybSupabase!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: paths, error } = await (client as any).rpc(
          'clear_my_import_storage',
          { p_scope: 'batch', p_id: batchId },
        );
        if (error) throw new Error(error.message);
        const list = (paths as string[]) ?? [];
        if (list.length === 0) return;
        const { error: storageError } = await client.storage
          .from('imports')
          .remove(list);
        if (storageError) throw new Error(storageError.message);
      }, b1);

      expect(await bucketObjectExists(u.id, 'b1-a.jpg')).toBe(false);
      expect(await bucketObjectExists(u.id, 'b1-b.jpg')).toBe(false);
      expect(await bucketObjectExists(u.id, 'b2-a.jpg')).toBe(true);

      type R = Array<{ batch_id: string; storage_path: string }>;
      const items = await adminGet<R>(
        `/rest/v1/import_items?select=batch_id,storage_path&owner_id=eq.${u.id}`,
      );
      const inB1 = items.filter((i) => i.batch_id === b1);
      const inB2 = items.filter((i) => i.batch_id !== b1);
      expect(inB1.every((i) => i.storage_path === '')).toBe(true);
      expect(inB2.every((i) => i.storage_path.length > 0)).toBe(true);
    } finally {
      await u.cleanup();
    }
  });

  test('all: clears every item across every batch the user owns', async ({ page }) => {
    const u = await createTestUser('ocr-del-all');
    try {
      await uploadFakeImage(u.id, 'all-1.jpg');
      await uploadFakeImage(u.id, 'all-2.jpg');
      await uploadFakeImage(u.id, 'all-3.jpg');
      await seedBatchWithItems({
        userId: u.id,
        batchName: 'All A',
        paths: ['all-1.jpg', 'all-2.jpg'],
      });
      await seedBatchWithItems({
        userId: u.id,
        batchName: 'All B',
        paths: ['all-3.jpg'],
      });

      await signIn(page, u);
      await page.goto('/settings/danger');
      // Drive the bulk-delete UI to also exercise the dialog wiring.
      await page.getByTestId('open-delete-all-ocr').click();
      await page.getByTestId('confirm-delete-all-ocr').click();
      // Dialog auto-closes on success — wait for it to disappear. The
      // open-delete-all-ocr button sits behind the dialog so just
      // checking visibility on it isn't enough; check the dialog
      // itself is gone.
      await expect(
        page.getByRole('dialog', { name: /Confirm OCR storage deletion/ }),
      ).toBeHidden({ timeout: 15_000 });

      expect(await bucketObjectExists(u.id, 'all-1.jpg')).toBe(false);
      expect(await bucketObjectExists(u.id, 'all-2.jpg')).toBe(false);
      expect(await bucketObjectExists(u.id, 'all-3.jpg')).toBe(false);

      type R = Array<{ storage_path: string }>;
      const items = await adminGet<R>(
        `/rest/v1/import_items?select=storage_path&owner_id=eq.${u.id}`,
      );
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items.every((i) => i.storage_path === '')).toBe(true);
    } finally {
      await u.cleanup();
    }
  });
});
