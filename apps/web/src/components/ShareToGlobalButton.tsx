import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Cookbook } from '@cookyourbooks/domain';
import {
  findSharedGlobalEntry,
  shareCollectionToGlobal,
} from '../data/shareCollection.js';

/**
 * "Share to global catalog" affordance on a PUBLISHED_BOOK collection.
 *
 * - First click confirms via a modal — sharing makes the cookbook's
 *   title list publicly discoverable in the global catalog.
 * - Subsequent clicks "update" the existing global entry (idempotent
 *   via `shared_from_collection_id` upsert in the RPC).
 * - ISBN is optional. The RPC rejects only if a *different* source has
 *   already claimed the same ISBN — that error surfaces inline.
 */
export function ShareToGlobalButton({ cookbook }: { cookbook: Cookbook }) {
  const qc = useQueryClient();
  const [showConfirm, setShowConfirm] = useState(false);

  const existing = useQuery({
    queryKey: ['shared-global-entry', cookbook.id],
    queryFn: () => findSharedGlobalEntry(cookbook.id),
    staleTime: 10_000,
  });

  const share = useMutation({
    mutationFn: () => shareCollectionToGlobal(cookbook.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shared-global-entry', cookbook.id] });
      qc.invalidateQueries({ queryKey: ['global-cookbook-by-isbn'] });
      setShowConfirm(false);
    },
  });

  const alreadyShared = !!existing.data;
  const label = share.isPending
    ? alreadyShared
      ? 'Updating…'
      : 'Sharing…'
    : alreadyShared
      ? 'Update shared catalog entry'
      : 'Share to global catalog';

  function onClick() {
    if (alreadyShared) {
      share.mutate();
    } else {
      setShowConfirm(true);
    }
  }

  return (
    <>
      <button
        onClick={onClick}
        disabled={share.isPending}
        className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60"
        title={
          alreadyShared
            ? 'Already in the global catalog — click to push your latest titles + metadata'
            : 'Add this cookbook to the publicly-readable global catalog'
        }
      >
        {label}
      </button>
      {share.error && (
        <span className="self-center text-xs text-red-700">
          {(share.error as Error).message}
        </span>
      )}
      {showConfirm && (
        <ConfirmDialog
          cookbook={cookbook}
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => share.mutate()}
          isPending={share.isPending}
        />
      )}
    </>
  );
}

function ConfirmDialog({
  cookbook,
  onCancel,
  onConfirm,
  isPending,
}: {
  cookbook: Cookbook;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-global-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="share-global-title" className="text-lg font-semibold">
          Share to global catalog?
        </h2>
        <p className="text-sm text-stone-700">
          This adds <strong>{cookbook.title}</strong> to the publicly-readable global cookbook
          catalog so other users can seed their own copy from your table of contents.
        </p>
        <ul className="space-y-1 text-xs text-stone-600">
          <li>· Your recipe titles will be visible to anyone (signed in or not).</li>
          <li>· Recipe details — ingredients, instructions, notes — stay private.</li>
          <li>· You can update or remove the global entry at any time.</li>
        </ul>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
          >
            {isPending ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  );
}
