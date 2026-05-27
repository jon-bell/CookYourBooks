import { supabase } from '../supabase.js';

/**
 * Two-step deletion: ask the server which paths to clear (also clears
 * them on the DB side), then call the storage API to actually remove
 * the bucket objects. Doing the storage delete on the client side
 * leans on the existing `imports_delete_own` RLS policy rather than
 * duplicating that gating in a security-definer function.
 *
 * Returns the number of bucket objects removed. Recipes that were
 * promoted from these items remain — only the source images and the
 * path references on `import_items` go away.
 */
export type StorageDeleteScope =
  | { kind: 'item'; itemId: string }
  | { kind: 'batch'; batchId: string }
  | { kind: 'all' };

export async function deleteOcrStorage(scope: StorageDeleteScope): Promise<number> {
  const scopeText = scope.kind;
  const id =
    scope.kind === 'item'
      ? scope.itemId
      : scope.kind === 'batch'
        ? scope.batchId
        : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: paths, error: rpcError } = await (supabase as any).rpc(
    'clear_my_import_storage',
    { p_scope: scopeText, p_id: id },
  );
  if (rpcError) throw new Error(rpcError.message);

  const list = (paths as string[] | null) ?? [];
  if (list.length === 0) return 0;

  // supabase.storage.remove is capped at 1000 paths per call. Chunk to
  // be safe for the 'all' scope on heavy users.
  const CHUNK = 500;
  let removed = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const { error: storageError } = await supabase.storage
      .from('imports')
      .remove(slice);
    if (storageError) {
      // Soft-fail: the DB columns are already cleared. The bucket
      // objects will be orphaned but the user no longer references
      // them. Surface the error so the UI can show a partial-failure
      // message.
      throw new Error(
        `Cleared ${i} of ${list.length} bucket objects, then storage delete failed: ${storageError.message}`,
      );
    }
    removed += slice.length;
  }
  return removed;
}
