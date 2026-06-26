import { useState } from 'react';

import { deleteOcrStorage } from '../import/deleteStorage.js';
import { useSync } from '../local/SyncProvider.js';

/**
 * Bulk "delete every OCR image I ever uploaded" surface. Lives on
 * /settings, separate from the Danger Zone (which deletes the entire
 * account). This one keeps the account intact — only the source
 * pictures stored in the `imports` bucket are wiped. The OCR-derived
 * drafts and any promoted recipes stay in place.
 *
 * Confirm dialog because the deletion is irreversible.
 */
export function OcrStorageSection() {
  const { syncNow } = useSync();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      const removed = await deleteOcrStorage({ kind: 'all' });
      await syncNow();
      setDone(removed);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="ocr-storage" className="mt-6 space-y-2">
      <h2 className="text-lg font-semibold">OCR uploaded images</h2>
      <p className="text-sm text-stone-700 dark:text-stone-300">
        Delete every source image you've uploaded for OCR import — recipes already promoted into
        your library will stay, only the source pictures go away.
      </p>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setDone(null);
          setError(null);
        }}
        data-testid="open-delete-all-ocr"
        className="rounded-md border border-red-400 dark:border-red-700 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
      >
        Delete all uploaded images…
      </button>
      {done !== null && (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">
          Removed {done} bucket {done === 1 ? 'object' : 'objects'}.
        </p>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm OCR storage deletion"
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="w-full max-w-md space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">Delete every uploaded OCR image?</h3>
            <p className="text-sm text-stone-700 dark:text-stone-300">
              This removes the bucket objects for <em>every</em> import batch you've created. The
              OCR'd drafts and any recipes you've promoted will stay. Recipes that still display an
              attached source image will lose that image.
            </p>
            {error && (
              <div
                data-testid="delete-all-ocr-error"
                className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300"
              >
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={busy}
                data-testid="confirm-delete-all-ocr"
                className="rounded-md bg-red-700 dark:bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 dark:hover:bg-red-500 disabled:opacity-60"
              >
                {busy ? 'Deleting…' : 'Delete all images'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
