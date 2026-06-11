import { useEffect } from 'react';

/**
 * Click-through warning shown before flipping a collection to public.
 *
 * The copy is intentionally blunt: people sometimes try to publish
 * someone else's cookbook contents wholesale, and the consequences
 * (DMCA notice, account ban) need to be obvious. The dialog blocks
 * publishing until the user explicitly confirms.
 */
export function MakePublicDialog({
  open,
  collectionTitle,
  onCancel,
  onConfirm,
  isPending,
}: {
  open: boolean;
  collectionTitle: string;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  // ESC closes; arrow keys do nothing. Keeping it small — this dialog
  // is rare and shouldn't fight with the rest of the page's keymap.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="make-public-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg space-y-3 rounded-lg bg-white dark:bg-stone-900 p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="make-public-title" className="text-lg font-semibold">
          Publish "{collectionTitle}" to Discover?
        </h2>
        <p className="text-sm text-stone-700 dark:text-stone-300">
          Anyone — signed in or not — will be able to read this collection's recipes and fork them
          into their own library.
        </p>
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          <p className="font-medium">Zero tolerance for copyright violations.</p>
          <p className="mt-1">
            Only publish recipes you wrote yourself, or that you have explicit permission to
            redistribute. Cookbooks tied to an ISBN can't be published at all — their recipes belong
            to the publisher.
          </p>
          <p className="mt-1">
            Rights holders can report a violation through our{' '}
            <a href="/legal/dmca" className="font-medium underline hover:no-underline">
              registered Copyright Agent
            </a>
            . Confirmed violations result in a <strong>lifetime account ban</strong>.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
          >
            {isPending ? 'Publishing…' : 'I understand, publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
