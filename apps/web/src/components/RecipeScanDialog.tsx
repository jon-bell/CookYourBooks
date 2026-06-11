import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { getSignedImportUrl } from '../import/ImportThumb.js';
import type { ImportItem } from '../import/model.js';
import { PinchPanImage } from './PinchPanImage.js';

/**
 * Lightbox view of the original scanned page(s) that produced a
 * recipe. Aggregates every storage path on every contributing
 * import_item (primary + any merged-in extras), in page order, signs
 * each one, and renders them stacked in a scrollable modal.
 *
 * Only rendered for the importing user — the parent gates on
 * useImportItemsForRecipe, which is owner-scoped.
 */
export function RecipeScanDialog({
  items,
  onClose,
}: {
  items: readonly ImportItem[];
  onClose: () => void;
}) {
  // Flatten primary + extra storage paths per item, preserving page
  // order. Each entry also remembers which item it came from so we
  // can offer a "open in review" link per page.
  const pages = useMemo(() => {
    const out: { path: string; item: ImportItem; index: number }[] = [];
    for (const it of items) {
      out.push({ path: it.storagePath, item: it, index: 0 });
      it.extraStoragePaths.forEach((p, i) => out.push({ path: p, item: it, index: i + 1 }));
    }
    return out;
  }, [items]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Original scan"
      className="fixed inset-0 z-50 flex flex-col bg-stone-950/90"
      onClick={onClose}
    >
      <header className="flex items-center justify-between border-b border-stone-800 px-4 py-2 text-sm text-stone-200">
        <span>
          Original scan ({pages.length} page{pages.length === 1 ? '' : 's'})
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded bg-stone-800 px-3 py-1 text-xs hover:bg-stone-700"
        >
          Close (esc)
        </button>
      </header>
      <div className="flex-1 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
          {pages.map((p) => (
            <ScanPage key={`${p.item.id}:${p.index}`} pagePath={p.path} item={p.item} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ScanPage({ pagePath, item }: { pagePath: string; item: ImportItem }) {
  const [url, setUrl] = useState<string | undefined>();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSignedImportUrl(pagePath)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pagePath]);

  return (
    <figure className="overflow-hidden rounded-lg bg-stone-900 ring-1 ring-stone-800">
      <div className="aspect-[3/4] w-full">
        {url ? (
          <PinchPanImage src={url} alt="Original scan" className="h-full w-full" />
        ) : errored ? (
          <div className="flex h-full w-full items-center justify-center text-sm text-stone-500">
            Couldn&apos;t load this page.
          </div>
        ) : (
          <div className="h-full w-full animate-pulse bg-stone-800" />
        )}
      </div>
      <figcaption className="flex items-center justify-between gap-2 border-t border-stone-800 px-3 py-2 text-xs text-stone-400">
        <span>Page index {item.pageIndex + 1}</span>
        <Link
          to={`/import/${item.batchId}/items/${item.id}`}
          className="text-stone-300 underline-offset-2 hover:underline"
        >
          Open in review →
        </Link>
      </figcaption>
    </figure>
  );
}
