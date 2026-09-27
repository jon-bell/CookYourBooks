import { useState } from 'react';

import { blockCollectionOwner } from './api.js';

/** Confirmation modal for blocking a public collection's author. The block
 *  hides every collection they publish from this user's Discover (server-
 *  side, so on every device) and notifies moderation. Reversible from
 *  Settings → Data & deletion. */
export function BlockAuthorDialog({
  collection,
  onClose,
  onBlocked,
}: {
  collection: { id: string; title: string; owner_name: string | null } | undefined;
  onClose: () => void;
  onBlocked: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!collection) return null;
  const who = collection.owner_name || 'this author';

  async function confirm() {
    if (!collection) return;
    setSubmitting(true);
    setError(null);
    try {
      await blockCollectionOwner(collection.id);
      onBlocked();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Block author"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white dark:bg-stone-900 p-6 shadow-lg ring-1 ring-stone-200"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Block {who}?</h2>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          You won't see "{collection.title}" or anything else {who} publishes on Discover. We'll
          also let our moderators know. You can unblock them any time in Settings → Data &amp;
          deletion.
        </p>
        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={submitting}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-60"
          >
            {submitting ? 'Blocking…' : 'Block'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
