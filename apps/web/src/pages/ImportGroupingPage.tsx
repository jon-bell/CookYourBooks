import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useImportBatch, useImportItems, useUpdateImportItem } from '../import/queries.js';
import { useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';
import { getSignedImportUrl, ImportThumb } from '../import/ImportThumb.js';
import { finalizeGrouping, kickOcr } from '../import/api.js';
import type { ImportItem } from '../import/model.js';
import { PinchPanImage } from '../components/PinchPanImage.js';

/**
 * "Group then OCR" review page. Shown right after upload for batches
 * created with `awaitGrouping: true`. Items are listed in page-index
 * order; the gap between any two adjacent thumbnails is a split
 * toggle. Default state is "split after every page" so every page is
 * its own recipe — clicking a gap removes its split, merging two
 * pages (and any further pages already part of the right neighbor's
 * group) into one recipe.
 *
 * On confirm we hand a `[[primary, …absorb], …]` payload to
 * `import_finalize_grouping`. The RPC appends absorbed items'
 * storage_paths onto the primary's `extra_storage_paths`, marks
 * absorbed items DISCARDED, and flips every remaining
 * AWAITING_GROUPING row in the batch to PENDING in one transaction.
 */
export function ImportGroupingPage() {
  const { batchId } = useParams();
  const navigate = useNavigate();
  const enabled = useLocalQueryEnabled();
  const { syncNow } = useSync();
  const updateItem = useUpdateImportItem();
  const { data: batch, isLoading: batchLoading } = useImportBatch(batchId);
  const { data: items = [], isLoading: itemsLoading } = useImportItems(batchId);

  // True = there IS a split between this position and the next one.
  // Indexed by left-item's index (0..n-2). Default: split everywhere.
  // Storing as a Set so toggles are O(1) and the empty state (= "all
  // grouped into one") is just an empty set.
  const [removedSplits, setRemovedSplits] = useState<Set<number>>(new Set());
  // Groups the user flagged as Table-of-Contents pages, keyed by the
  // group's primary (first/lowest-page) item id so the flag follows the
  // lead page as splits change.
  const [tocPrimaryIds, setTocPrimaryIds] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  // Items in upload order. Only AWAITING_GROUPING items participate in
  // the grouping decision — any item already past that status (e.g.,
  // user came back to this page after confirming) is shown but ignored
  // when building the payload.
  const groupable: ImportItem[] = useMemo(
    () =>
      [...items]
        .filter((it) => it.status === 'AWAITING_GROUPING')
        .sort((a, b) => a.pageIndex - b.pageIndex),
    [items],
  );

  // Walk groupable items left-to-right. Start a new group whenever
  // there's a split AFTER the previous item (i.e., the index of the
  // previous item is NOT in `removedSplits`).
  const groups: ImportItem[][] = useMemo(() => {
    if (groupable.length === 0) return [];
    const out: ImportItem[][] = [[groupable[0]!]];
    for (let i = 1; i < groupable.length; i += 1) {
      const splitRemoved = removedSplits.has(i - 1);
      if (splitRemoved) {
        out[out.length - 1]!.push(groupable[i]!);
      } else {
        out.push([groupable[i]!]);
      }
    }
    return out;
  }, [groupable, removedSplits]);

  function toggleSplit(leftIdx: number) {
    setRemovedSplits((prev) => {
      const next = new Set(prev);
      if (next.has(leftIdx)) next.delete(leftIdx);
      else next.add(leftIdx);
      return next;
    });
  }

  function toggleToc(primaryId: string) {
    setTocPrimaryIds((prev) => {
      const next = new Set(prev);
      if (next.has(primaryId)) next.delete(primaryId);
      else next.add(primaryId);
      return next;
    });
  }

  function resetToAllSplit() {
    setRemovedSplits(new Set());
  }

  function mergeAll() {
    // Drop every split — collapse the whole batch into one recipe.
    const all = new Set<number>();
    for (let i = 0; i < groupable.length - 1; i += 1) all.add(i);
    setRemovedSplits(all);
  }

  async function confirm() {
    if (!batchId || groupable.length === 0) return;
    setError(undefined);
    setConfirming(true);
    try {
      const payload = groups.map((g) => g.map((it) => it.id));
      // Flag ToC groups BEFORE finalizing. The items are still
      // AWAITING_GROUPING, so this sets is_toc without touching status
      // (the outbox push carries is_toc but never a non-terminal status
      // flip). After syncNow lands it, finalizeGrouping flips the rows to
      // PENDING with is_toc intact, so the worker OCRs them with the
      // table-of-contents prompt on the first pass — no re-OCR needed.
      const tocIds = groups
        .filter((g) => tocPrimaryIds.has(g[0]!.id))
        .map((g) => g[0]!.id);
      for (const id of tocIds) {
        await updateItem.mutateAsync({ id, patch: { isToc: true } });
      }
      if (tocIds.length > 0) await syncNow();
      await finalizeGrouping(batchId, payload);
      // Worker picks up PENDING rows on the next pg_cron tick; kick it
      // so the user sees progress immediately. Best-effort.
      try {
        await kickOcr(batchId);
      } catch {
        // pg_cron will pick this up.
      }
      await syncNow();
      navigate(`/import/${batchId}`);
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    }
  }

  if (!enabled || batchLoading || itemsLoading) {
    return <p className="text-stone-500 dark:text-stone-400">Loading…</p>;
  }
  if (!batch) {
    return (
      <div className="space-y-2">
        <p className="text-stone-700 dark:text-stone-300">Batch not found locally.</p>
        <button
          type="button"
          onClick={() => void syncNow()}
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          Sync now
        </button>
      </div>
    );
  }
  if (groupable.length === 0) {
    // No AWAITING_GROUPING items — either already finalized or this
    // batch was never group-first. Redirect home for the batch.
    return (
      <div className="space-y-3">
        <p className="text-stone-700 dark:text-stone-300">
          Nothing left to group for this batch.
        </p>
        <button
          type="button"
          onClick={() => navigate(`/import/${batch.id}`)}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          Go to batch
        </button>
      </div>
    );
  }

  const totalPages = groupable.length;
  const recipeCount = groups.length;
  const multiPageGroups = groups.filter((g) => g.length > 1).length;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
          {batch.name} · grouping
        </div>
        <h1 className="text-2xl font-semibold">Group pages into recipes</h1>
        <p className="max-w-3xl text-sm text-stone-600 dark:text-stone-400">
          Each page is its own recipe by default. Click a page to view it
          fullscreen, then click the{' '}
          <span className="font-medium">split</span> between two pages to merge
          them — pages in the same colored band become one recipe and OCR will
          read them together.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900 px-3 py-2 text-sm">
        <span>
          <strong>{recipeCount}</strong>{' '}
          {recipeCount === 1 ? 'recipe' : 'recipes'} from{' '}
          <strong>{totalPages}</strong> pages
          {multiPageGroups > 0 && (
            <span className="text-stone-500 dark:text-stone-400">
              {' '}
              · {multiPageGroups} multi-page
            </span>
          )}
        </span>
        <span className="ml-auto flex gap-2 text-xs">
          <button
            type="button"
            onClick={resetToAllSplit}
            className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            One recipe per page
          </button>
          <button
            type="button"
            onClick={mergeAll}
            className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Everything is one recipe
          </button>
        </span>
      </div>

      <GroupingStrip
        groups={groups}
        removedSplits={removedSplits}
        groupable={groupable}
        tocPrimaryIds={tocPrimaryIds}
        onToggleToc={toggleToc}
        onToggleSplit={toggleSplit}
        onPreview={(idx) => setPreviewIndex(idx)}
      />

      {previewIndex !== null && (
        <PagePreviewOverlay
          item={groupable[previewIndex]!}
          index={previewIndex}
          total={groupable.length}
          onClose={() => setPreviewIndex(null)}
          onNavigate={setPreviewIndex}
        />
      )}

      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={confirming || groupable.length === 0}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
        >
          {confirming
            ? 'Starting OCR…'
            : `Start OCR on ${recipeCount} ${
                recipeCount === 1 ? 'recipe' : 'recipes'
              }`}
        </button>
        <button
          type="button"
          onClick={() => navigate(`/import/${batch.id}`)}
          disabled={confirming}
          className="rounded-md px-4 py-2 text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Horizontal scroll strip of thumbnails interleaved with clickable
 * split toggles. The visual cue for "merged" (no split between
 * neighbors) is a subtle linking band; "split" is a wider gap with a
 * vertical rule. Each group is alternately shaded to make the recipe
 * boundaries unambiguous.
 */
function GroupingStrip({
  groups,
  removedSplits,
  groupable,
  tocPrimaryIds,
  onToggleToc,
  onToggleSplit,
  onPreview,
}: {
  groups: ImportItem[][];
  removedSplits: Set<number>;
  groupable: ImportItem[];
  tocPrimaryIds: Set<string>;
  onToggleToc: (primaryId: string) => void;
  onToggleSplit: (leftIdx: number) => void;
  onPreview: (idx: number) => void;
}) {
  // Map item.id -> its index inside `groupable`, used by the split
  // gap to know which split toggle it represents.
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    groupable.forEach((it, i) => m.set(it.id, i));
    return m;
  }, [groupable]);

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-min items-stretch gap-0 pb-2">
        {groups.map((g, gi) => {
          const primaryId = g[0]!.id;
          const isToc = tocPrimaryIds.has(primaryId);
          return (
          <div
            key={g.map((it) => it.id).join('-')}
            className={`flex shrink-0 flex-col gap-1 rounded-md p-2 ${
              isToc
                ? 'bg-indigo-50 ring-2 ring-indigo-400 dark:bg-indigo-950/40'
                : gi % 2 === 0
                  ? 'bg-stone-50'
                  : 'bg-amber-50'
            }`}
          >
            <label className="flex cursor-pointer items-center gap-1.5 self-start rounded px-1 text-[11px] font-medium text-stone-600 dark:text-stone-300">
              <input
                type="checkbox"
                checked={isToc}
                onChange={() => onToggleToc(primaryId)}
                className="h-3.5 w-3.5"
              />
              Table of Contents
            </label>
            <div className="flex items-stretch gap-1">
            {g.map((it, ii) => {
              const idxInBatch = indexById.get(it.id)!;
              const isLastInBatch = idxInBatch === groupable.length - 1;
              return (
                <div key={it.id} className="flex items-stretch">
                  <Thumb
                    item={it}
                    pageInGroup={ii + 1}
                    groupSize={g.length}
                    onPreview={() => onPreview(idxInBatch)}
                  />
                  {/* Splits live BETWEEN thumbs; render the right-side
                      gap on every thumb except the very last in the
                      batch. The gap toggles the split at index
                      `idxInBatch` (= the split AFTER this thumb). */}
                  {!isLastInBatch && (
                    <SplitGap
                      removed={removedSplits.has(idxInBatch)}
                      onClick={() => onToggleSplit(idxInBatch)}
                    />
                  )}
                </div>
              );
            })}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

function Thumb({
  item,
  pageInGroup,
  groupSize,
  onPreview,
}: {
  item: ImportItem;
  pageInGroup: number;
  groupSize: number;
  onPreview: () => void;
}) {
  return (
    <div className="flex w-32 flex-col items-center gap-1">
      <button
        type="button"
        onClick={onPreview}
        title={`View page ${item.pageIndex + 1} fullscreen`}
        aria-label={`View page ${item.pageIndex + 1} fullscreen`}
        className="aspect-[3/4] w-full overflow-hidden rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 hover:border-stone-500 dark:hover:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-400"
      >
        <ImportThumb
          path={item.thumbPath ?? item.storagePath}
          alt={`Page ${item.pageIndex + 1}`}
          className="h-full w-full object-cover"
        />
      </button>
      <div className="text-[11px] leading-tight text-stone-600 dark:text-stone-400">
        Page {item.pageIndex + 1}
        {groupSize > 1 && (
          <span className="ml-1 text-stone-400">
            ({pageInGroup}/{groupSize})
          </span>
        )}
      </div>
    </div>
  );
}

function SplitGap({
  removed,
  onClick,
}: {
  removed: boolean;
  onClick: () => void;
}) {
  // Two visual modes:
  //  - removed=true: the split has been TAKEN AWAY (pages are merged).
  //    Render a slim linking bar.
  //  - removed=false: the split is PRESENT (recipe boundary). Render a
  //    wider gap with a vertical rule.
  if (removed) {
    return (
      <button
        type="button"
        onClick={onClick}
        title="Click to split these pages into separate recipes"
        aria-label="Split here"
        className="group mx-0.5 flex w-3 items-center justify-center"
      >
        <span className="block h-12 w-1 rounded-full bg-stone-400 group-hover:bg-stone-700" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title="Click to merge these pages into one recipe"
      aria-label="Merge here"
      className="group mx-1 flex w-8 flex-col items-center justify-center gap-1"
    >
      <span className="text-[10px] uppercase tracking-wide text-stone-400 group-hover:text-stone-700">
        split
      </span>
      <span className="block h-12 w-px bg-stone-300 dark:bg-stone-600 group-hover:bg-stone-700" />
      <span className="text-[10px] uppercase tracking-wide text-stone-400 group-hover:text-stone-700">
        merge?
      </span>
    </button>
  );
}

function PagePreviewOverlay({
  item,
  index,
  total,
  onClose,
  onNavigate,
}: {
  item: ImportItem;
  index: number;
  total: number;
  onClose: () => void;
  onNavigate: (idx: number) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | undefined>();
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setImgUrl(undefined);
    setLoadError(false);
    void getSignedImportUrl(item.storagePath)
      .then((u) => {
        if (!cancelled) setImgUrl(u);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.storagePath]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault();
        if (index > 0) onNavigate(index - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault();
        if (index < total - 1) onNavigate(index + 1);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, total, onClose, onNavigate]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Page ${item.pageIndex + 1} preview`}
      className="fixed inset-0 z-50 flex flex-col bg-stone-900/95"
      onClick={onClose}
    >
      <div
        className="relative min-h-0 flex-1"
        onClick={(e) => e.stopPropagation()}
      >
        {imgUrl ? (
          <PinchPanImage
            src={imgUrl}
            alt={`Page ${item.pageIndex + 1}`}
            className="relative h-full w-full"
          />
        ) : loadError ? (
          <div className="flex h-full items-center justify-center text-sm text-stone-300">
            Could not load page image.
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-stone-400">
            Loading…
          </div>
        )}
      </div>

      <div
        className="flex shrink-0 flex-wrap items-center gap-3 border-t border-white/10 px-4 py-3 text-sm text-white/90"
        onClick={(e) => e.stopPropagation()}
      >
        <span>
          Page {item.pageIndex + 1} · {index + 1} of {total}
        </span>
        <span className="hidden text-white/60 sm:inline">
          Pinch or ⌘+scroll to zoom · drag to pan · ← / → to move between pages
        </span>
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onNavigate(index - 1)}
            className="rounded-md border border-white/20 px-3 py-1.5 hover:bg-white/10 disabled:opacity-40"
          >
            ← Prev
          </button>
          <button
            type="button"
            disabled={index >= total - 1}
            onClick={() => onNavigate(index + 1)}
            className="rounded-md border border-white/20 px-3 py-1.5 hover:bg-white/10 disabled:opacity-40"
          >
            Next →
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-white/90 px-3 py-1.5 font-medium text-stone-900 hover:bg-white"
          >
            Close
          </button>
        </span>
      </div>
    </div>
  );
}
