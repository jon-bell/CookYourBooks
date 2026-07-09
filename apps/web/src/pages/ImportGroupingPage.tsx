import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { LoadingState } from '../components/LoadingState.js';
import { SAFE_BOTTOM, TAP_TARGET } from '../components/mobileSafeArea.js';
import { PinchPanImage } from '../components/PinchPanImage.js';
import {
  finalizeGrouping,
  getEffectiveOcrConfig,
  kickOcr,
  mergeImportItems,
  resetImportItem,
  setImportItemKind,
  splitImportItem,
} from '../import/api.js';
import {
  buildFinalizePayload,
  deriveGroups,
  mergeAllSplits,
  toggleInSet,
} from '../import/groupingModel.js';
import { getSignedImportUrl, ImportThumb } from '../import/ImportThumb.js';
import type { ImportItem } from '../import/model.js';
import { KIND_OPTIONS, type PageKind } from '../import/pageMarker.js';
import { useImportBatch, useImportItems, useUpdateImportItem } from '../import/queries.js';
import { rotateImportItemImage } from '../import/rotateItemImage.js';
import { useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';

/** Adjustable thumbnail size for the organizer's page cards (1a). Persisted
 *  per-device in localStorage; maps to a container width class. */
type ThumbSize = 'sm' | 'md' | 'lg';
const THUMB_SIZE_KEY = 'cookyourbooks.import.thumbSize';
const THUMB_WIDTH_CLASS: Record<ThumbSize, string> = {
  sm: 'w-20 sm:w-24',
  md: 'w-24 sm:w-28',
  lg: 'w-32 sm:w-40',
};
function readThumbSize(): ThumbSize {
  if (typeof window === 'undefined') return 'md';
  try {
    const v = window.localStorage.getItem(THUMB_SIZE_KEY);
    if (v === 'sm' || v === 'md' || v === 'lg') return v;
  } catch {
    /* private mode / storage disabled — fall back to default */
  }
  return 'md';
}
function writeThumbSize(size: ThumbSize): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THUMB_SIZE_KEY, size);
  } catch {
    /* private mode / storage disabled — in-memory only */
  }
}

/**
 * Mobile-first "Organize / review" page for a scan session. Runs in two modes,
 * chosen from the items' statuses:
 *
 * - **preOcr** (`hasAwaiting`): shown right after a group-first scan
 *   (`awaitGrouping: true`). Only the AWAITING_GROUPING items participate; the
 *   user thumbs through the captured pages, sets each recipe's page type
 *   (Recipe / Contents / Notes), and adjusts stitching — then `confirm()` hands
 *   a `[[primary, …absorb], …]` payload to `import_finalize_grouping` (absorb +
 *   flip AWAITING→PENDING). This is the original behavior, unchanged.
 *
 * - **reorganize** (no AWAITING items): the FULL organizer over an
 *   already-OCR'd batch. All non-DISCARDED items are listed one-recipe-per-page
 *   (the committed state), and the user can re-merge / re-split / re-tag /
 *   rotate pages. `confirm()` applies the deltas against rows that already
 *   exist server-side by re-OCRing only what changed: `setImportItemKind` for
 *   retagged leaders, `mergeImportItems` for new multi-page groups, and
 *   `resetImportItem` for rotated singletons. Already-committed multi-page
 *   recipes can be broken apart in place via `import_split_item` ("Ungroup").
 *
 * Grouping model (pure, in `groupingModel.ts`): items are listed in page-index
 * order and a `removedSplits` set records which split between two adjacent
 * pages has been TAKEN AWAY — removing a split merges its two pages into one
 * recipe. Default is "split after every page" (one recipe per page).
 */
export function ImportGroupingPage() {
  const { batchId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const enabled = useLocalQueryEnabled();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  const updateItem = useUpdateImportItem();
  const { data: batch, isLoading: batchLoading } = useImportBatch(batchId);
  const { data: items = [], isLoading: itemsLoading } = useImportItems(batchId);

  // Split indices removed at capture time (camera chain toggle) → merge those
  // pages by default. Read once on mount; a cold reload (no router state) —
  // including every reorganize-mode entry — falls back to one-recipe-per-page
  // with every page still present (the committed state).
  const initialMerges = (location.state as { initialMerges?: number[] } | null)?.initialMerges;
  const [removedSplits, setRemovedSplits] = useState<Set<number>>(
    () => new Set(initialMerges ?? []),
  );
  // Per-group page-type overrides, keyed by the group's primary (lowest-page)
  // item id so the choice follows the lead page as splits change. Missing key
  // => use the captured `item.kind` (see `effectiveKind`).
  const [modeOverrides, setModeOverrides] = useState<Map<string, PageKind>>(() => new Map());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  // Manual page rotation. `rotatingId` gates concurrent single-page rotates;
  // `rotatingAll` gates the whole-batch "Rotate all"; `rotationVersion` bumps
  // per item so thumbnails + the preview re-fetch the rewritten bytes (the
  // signed-URL cache is busted inside rotateImportItemImage).
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotatingAll, setRotatingAll] = useState(false);
  const [rotateAllProgress, setRotateAllProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [rotationVersion, setRotationVersion] = useState<Map<string, number>>(() => new Map());
  const [rotateError, setRotateError] = useState<string | undefined>();
  // Adjustable thumbnail size (1a). Lazy-read from localStorage on mount.
  const [thumbSize, setThumbSize] = useState<ThumbSize>(readThumbSize);
  // "Ungroup" (import_split_item) busy gate, keyed by the primary being split.
  const [splittingId, setSplittingId] = useState<string | null>(null);

  // Mode is driven by the items: any AWAITING_GROUPING row means a group-first
  // batch still waiting for its first OCR pass (preOcr); otherwise we're
  // re-organizing an already-scanned batch (reorganize).
  const hasAwaiting = useMemo(() => items.some((i) => i.status === 'AWAITING_GROUPING'), [items]);
  const mode: 'preOcr' | 'reorganize' = hasAwaiting ? 'preOcr' : 'reorganize';

  // Items in page order. preOcr: only the AWAITING_GROUPING pages participate.
  // reorganize: every non-DISCARDED item (absorbed pages are DISCARDED and
  // surface only under their primary's "Ungroup" control).
  const groupable: ImportItem[] = useMemo(() => {
    const kept = hasAwaiting
      ? items.filter((it) => it.status === 'AWAITING_GROUPING')
      : items.filter((it) => it.status !== 'DISCARDED');
    return [...kept].sort((a, b) => a.pageIndex - b.pageIndex);
  }, [items, hasAwaiting]);
  const groupableById = useMemo(() => {
    const m = new Map<string, ImportItem>();
    for (const it of groupable) m.set(it.id, it);
    return m;
  }, [groupable]);

  const groups: ImportItem[][] = useMemo(
    () => deriveGroups(groupable, removedSplits),
    [groupable, removedSplits],
  );

  const effectiveKind = (leader: ImportItem): PageKind =>
    modeOverrides.get(leader.id) ?? leader.kind;

  function toggleSplit(leftIdx: number) {
    setRemovedSplits((prev) => toggleInSet(prev, leftIdx));
  }

  function setMode(leaderId: string, kind: PageKind) {
    setModeOverrides((prev) => {
      const next = new Map(prev);
      next.set(leaderId, kind);
      return next;
    });
  }

  function resetToAllSplit() {
    setRemovedSplits(new Set());
  }

  function mergeAll() {
    setRemovedSplits(mergeAllSplits(groupable.length));
  }

  function changeThumbSize(size: ThumbSize) {
    setThumbSize(size);
    writeThumbSize(size);
  }

  function bumpRotation(id: string) {
    setRotationVersion((prev) => {
      const next = new Map(prev);
      next.set(id, (prev.get(id) ?? 0) + 1);
      return next;
    });
  }

  // Rotate one page image 90° (turns = +1 CW / -1 CCW) and re-upload in place.
  // In reorganize mode a rotated singleton is re-OCR'd on confirm (step 3);
  // pre-OCR the worker just reads the rewritten bytes when grouping is confirmed.
  async function rotateItem(item: ImportItem, quarterTurns: number) {
    if (rotatingId || rotatingAll) return;
    setRotatingId(item.id);
    setRotateError(undefined);
    try {
      await rotateImportItemImage(item, quarterTurns);
      bumpRotation(item.id);
    } catch (e) {
      setRotateError(`Couldn't rotate the page: ${(e as Error).message}`);
    } finally {
      setRotatingId(null);
    }
  }

  // Rotate EVERY page by the same amount (1c). Sequential so the single
  // cr-sqlite/storage pipeline isn't hammered; shows running progress.
  async function rotateAll(quarterTurns: number) {
    if (rotatingAll || rotatingId) return;
    setRotatingAll(true);
    setRotateError(undefined);
    setRotateAllProgress({ done: 0, total: groupable.length });
    try {
      for (let i = 0; i < groupable.length; i += 1) {
        const it = groupable[i]!;
        await rotateImportItemImage(it, quarterTurns);
        bumpRotation(it.id);
        setRotateAllProgress({ done: i + 1, total: groupable.length });
      }
    } catch (e) {
      setRotateError(`Couldn't rotate all pages: ${(e as Error).message}`);
    } finally {
      setRotatingAll(false);
      setRotateAllProgress(null);
    }
  }

  // Reorganize-mode: break a committed multi-page recipe apart (Part B). Immediate
  // action — the server RPC revives the absorbed pages + clears the primary's
  // extras, then a sync reflows them into the list as standalone items.
  async function ungroupItem(leader: ImportItem) {
    if (!batchId || splittingId) return;
    setSplittingId(leader.id);
    setError(undefined);
    try {
      await splitImportItem(leader.id);
      try {
        await kickOcr(batchId);
      } catch {
        // pg_cron will pick this up.
      }
      await syncNow();
      void qc.invalidateQueries({ queryKey: ['import-items'] });
    } catch (e) {
      setError(`Couldn't ungroup this recipe: ${(e as Error).message}`);
    } finally {
      setSplittingId(null);
    }
  }

  // preOcr confirm — the original "Group then OCR" finalize path, unchanged.
  async function confirmPreOcr() {
    if (!batchId || groupable.length === 0) return;
    setError(undefined);
    setConfirming(true);
    try {
      const payload = buildFinalizePayload(groups);
      // Persist any changed page types on the group leaders BEFORE finalizing.
      // Items are still AWAITING_GROUPING, so this sets kind (RECIPE/TOC/NOTES)
      // without flipping status (the outbox push carries kind but never a
      // non-terminal status flip). After syncNow lands it, finalizeGrouping
      // releases the rows to PENDING with kind intact, so the worker OCRs them
      // with the right prompt on the first pass — no re-OCR needed.
      const kindChanges = groups
        .map((g) => g[0]!)
        .map((leader) => ({ id: leader.id, kind: effectiveKind(leader) }))
        .filter((c) => c.kind !== (groupableById.get(c.id)?.kind ?? 'RECIPE'));
      for (const c of kindChanges) {
        await updateItem.mutateAsync({ id: c.id, patch: { kind: c.kind } });
      }
      if (kindChanges.length > 0) await syncNow();
      await finalizeGrouping(batchId, payload);
      try {
        await kickOcr(batchId);
      } catch {
        // pg_cron will pick this up.
      }
      await syncNow();
      void navigate(`/import/${batchId}`);
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    }
  }

  // reorganize confirm — apply the deltas to already-existing rows, re-OCRing
  // only what changed. Nothing is pushed/finalized (the rows exist server-side).
  async function confirmReorganize() {
    if (!batchId) return;
    if (reorgChangeCount === 0) {
      void navigate(`/import/${batchId}`);
      return;
    }
    if (
      !window.confirm(
        `Re-organize this scanned batch? ${reorgChangeCount} page${
          reorgChangeCount === 1 ? '' : 's'
        } will be re-OCR'd with your current OCR settings.`,
      )
    ) {
      return;
    }
    setError(undefined);
    setConfirming(true);
    try {
      const cfg = await getEffectiveOcrConfig().catch(() => null);
      const rearmed = new Set<string>();
      // 1. Kind changes (setImportItemKind resets + re-OCRs the leader).
      for (const g of groups) {
        const leader = g[0]!;
        const kind = effectiveKind(leader);
        if (kind !== leader.kind) {
          await setImportItemKind(leader.id, kind);
          rearmed.add(leader.id);
        }
      }
      // 2. Merges (mergeImportItems re-OCRs the primary with all its pages).
      for (const g of groups) {
        if (g.length > 1) {
          await mergeImportItems(
            g[0]!.id,
            g.slice(1).map((i) => i.id),
          );
        }
      }
      // 3. Rotations on untouched singletons — re-arm for a fresh OCR pass so
      //    the rewritten bytes are read (skip anything already re-armed above).
      for (const g of groups) {
        if (g.length !== 1) continue;
        const it = g[0]!;
        if ((rotationVersion.get(it.id) ?? 0) > 0 && !rearmed.has(it.id)) {
          await resetImportItem(it.id, cfg ?? undefined);
        }
      }
      try {
        await kickOcr(batchId);
      } catch {
        // pg_cron will pick this up.
      }
      await syncNow();
      void navigate(`/import/${batchId}`);
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    }
  }

  function confirm() {
    return mode === 'reorganize' ? confirmReorganize() : confirmPreOcr();
  }

  if (!enabled || batchLoading || itemsLoading) {
    return <LoadingState surface="import-grouping" />;
  }
  if (!batch) {
    return (
      <div className="space-y-2">
        <p className="text-stone-700 dark:text-stone-300">Batch not found locally.</p>
        <button
          type="button"
          onClick={() => void syncNow()}
          className={`rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 ${TAP_TARGET}`}
        >
          Sync now
        </button>
      </div>
    );
  }
  if (groupable.length === 0) {
    // Truly empty batch (every item discarded, or nothing uploaded yet).
    return (
      <div className="space-y-3">
        <p className="text-stone-700 dark:text-stone-300">Nothing to organize in this batch.</p>
        <button
          type="button"
          onClick={() => navigate(`/import/${batch.id}`)}
          className={`rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 ${TAP_TARGET}`}
        >
          Go to batch
        </button>
      </div>
    );
  }

  const totalPages = groupable.length;
  const recipeCount = groups.length;
  const multiPageGroups = groups.filter((g) => g.length > 1).length;

  // How many pages a reorganize confirm will re-OCR: pages in multi-item
  // groups + rotated singletons + retagged leaders. A rough proxy for the
  // confirm copy (a page touched two ways may count twice — that's fine).
  const multiItemPageCount = groups.reduce((n, g) => (g.length > 1 ? n + g.length : n), 0);
  const rotatedSingletonCount = groups.filter(
    (g) => g.length === 1 && (rotationVersion.get(g[0]!.id) ?? 0) > 0,
  ).length;
  const kindChangedLeaderCount = groups.filter((g) => effectiveKind(g[0]!) !== g[0]!.kind).length;
  const reorgChangeCount = multiItemPageCount + rotatedSingletonCount + kindChangedLeaderCount;

  const previewItem = previewIndex !== null ? groupable[previewIndex] : undefined;
  const previewLeader = previewItem
    ? (groups.find((g) => g.some((it) => it.id === previewItem.id))?.[0] ?? previewItem)
    : undefined;

  const rotateBusy = rotatingAll || rotatingId !== null;
  const confirmLabel =
    mode === 'reorganize'
      ? confirming
        ? 'Applying…'
        : reorgChangeCount === 0
          ? 'Done'
          : `Apply & re-OCR ${reorgChangeCount} ${reorgChangeCount === 1 ? 'page' : 'pages'}`
      : confirming
        ? 'Starting OCR…'
        : `Start OCR on ${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'}`;

  return (
    <div className="space-y-4">
      {/* Sticky summary — stays on screen while the cards scroll. */}
      <div className="sticky top-0 z-10 -mx-4 border-b border-stone-200 dark:border-stone-800 bg-white/95 px-4 py-3 backdrop-blur dark:bg-stone-950/95">
        <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
          {batch.name} · organize
        </div>
        <h1 className="text-xl font-semibold">Organize into recipes</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span>
            <strong>{recipeCount}</strong> {recipeCount === 1 ? 'recipe' : 'recipes'} from{' '}
            <strong>{totalPages}</strong> {totalPages === 1 ? 'page' : 'pages'}
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
              className={`rounded-md border border-stone-300 dark:border-stone-600 bg-white px-2 py-1 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 ${TAP_TARGET}`}
            >
              One per page
            </button>
            <button
              type="button"
              onClick={mergeAll}
              className={`rounded-md border border-stone-300 dark:border-stone-600 bg-white px-2 py-1 hover:bg-stone-100 dark:bg-stone-900 dark:hover:bg-stone-800 ${TAP_TARGET}`}
            >
              One recipe
            </button>
          </span>
        </div>
        {/* Thumbnail size (1a) + Rotate all (1c). */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="text-stone-500 dark:text-stone-400">Size</span>
            <ThumbSizeControl value={thumbSize} onChange={changeThumbSize} />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-stone-500 dark:text-stone-400">Rotate all</span>
            <div className="inline-flex items-center gap-1">
              <RotateAllButton
                glyph="↺"
                label="Rotate all pages left 90°"
                disabled={rotateBusy}
                onClick={() => void rotateAll(-1)}
              />
              <RotateAllButton
                glyph="180°"
                label="Rotate all pages 180°"
                disabled={rotateBusy}
                onClick={() => void rotateAll(2)}
              />
              <RotateAllButton
                glyph="↻"
                label="Rotate all pages right 90°"
                disabled={rotateBusy}
                onClick={() => void rotateAll(1)}
              />
            </div>
            {rotatingAll && rotateAllProgress && (
              <span className="text-stone-600 dark:text-stone-400">
                Rotating {rotateAllProgress.done}/{rotateAllProgress.total}…
              </span>
            )}
          </span>
        </div>
      </div>

      <p className="text-sm text-stone-600 dark:text-stone-400">
        {mode === 'reorganize' ? (
          <>
            This batch has already been scanned. Re-merge, split, rotate, or re-tag pages, then{' '}
            <span className="font-medium">apply</span> — only the pages you change are re-OCR'd. Tap
            a page to view it fullscreen.
          </>
        ) : (
          <>
            Each page is its own recipe by default. Tap a page to view it fullscreen. Use{' '}
            <span className="font-medium">Merge with next recipe</span> to join two pages into one
            recipe, or the <span className="font-medium">✂</span> between pages to split them apart.
            Set a recipe's type with the Recipe / Contents / Notes toggle.
          </>
        )}
      </p>

      <RecipeCardList
        groups={groups}
        groupable={groupable}
        thumbSize={thumbSize}
        effectiveKind={effectiveKind}
        onSetMode={setMode}
        onToggleSplit={toggleSplit}
        onPreview={(idx) => setPreviewIndex(idx)}
        onRotate={rotateItem}
        rotatingId={rotatingId}
        rotatingAll={rotatingAll}
        rotationVersion={rotationVersion}
        canUngroup={mode === 'reorganize'}
        onUngroup={ungroupItem}
        splittingId={splittingId}
      />

      {previewItem && previewLeader && (
        <PagePreviewOverlay
          item={previewItem}
          index={previewIndex!}
          total={groupable.length}
          orderedItems={groupable}
          groups={groups}
          removedSplits={removedSplits}
          leaderKind={effectiveKind(previewLeader)}
          onSetMode={(k) => setMode(previewLeader.id, k)}
          onToggleSplit={toggleSplit}
          onRotate={(turns) => void rotateItem(previewItem, turns)}
          rotating={rotatingId === previewItem.id || rotatingAll}
          rotationVersion={rotationVersion}
          version={rotationVersion.get(previewItem.id) ?? 0}
          onClose={() => setPreviewIndex(null)}
          onNavigate={setPreviewIndex}
        />
      )}

      {rotateError && <p className="text-sm text-red-700 dark:text-red-300">{rotateError}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

      {/* Sticky confirm bar. */}
      <div
        className={`sticky bottom-0 z-10 -mx-4 flex gap-3 border-t border-stone-200 dark:border-stone-800 bg-white/95 px-4 py-3 backdrop-blur dark:bg-stone-950/95 ${SAFE_BOTTOM}`}
      >
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={confirming || groupable.length === 0}
          className={`flex-1 rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50 ${TAP_TARGET}`}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => navigate(`/import/${batch.id}`)}
          disabled={confirming}
          className={`rounded-md px-4 py-2 text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 disabled:opacity-50 ${TAP_TARGET}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Segmented S / M / L thumbnail-size control (1a). */
function ThumbSizeControl({
  value,
  onChange,
}: {
  value: ThumbSize;
  onChange: (size: ThumbSize) => void;
}) {
  const options: { size: ThumbSize; label: string; aria: string }[] = [
    { size: 'sm', label: 'S', aria: 'Small thumbnails' },
    { size: 'md', label: 'M', aria: 'Medium thumbnails' },
    { size: 'lg', label: 'L', aria: 'Large thumbnails' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Thumbnail size"
      className="inline-flex overflow-hidden rounded-md border border-stone-300 dark:border-stone-600"
    >
      {options.map((opt) => {
        const active = value === opt.size;
        return (
          <button
            key={opt.size}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.aria}
            onClick={() => onChange(opt.size)}
            className={`min-h-[32px] px-2.5 text-xs font-medium ${
              active
                ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                : 'bg-white text-stone-600 hover:bg-stone-100 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** One of the "Rotate all" header buttons (1c). Direction-indicating glyph. */
function RotateAllButton({
  glyph,
  label,
  disabled,
  onClick,
}: {
  glyph: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="min-h-[32px] rounded border border-stone-300 dark:border-stone-600 px-2 text-sm text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40"
    >
      {glyph}
    </button>
  );
}

/** Vertical list of recipe cards with between-card "merge" dividers. */
function RecipeCardList({
  groups,
  groupable,
  thumbSize,
  effectiveKind,
  onSetMode,
  onToggleSplit,
  onPreview,
  onRotate,
  rotatingId,
  rotatingAll,
  rotationVersion,
  canUngroup,
  onUngroup,
  splittingId,
}: {
  groups: ImportItem[][];
  groupable: ImportItem[];
  thumbSize: ThumbSize;
  effectiveKind: (leader: ImportItem) => PageKind;
  onSetMode: (leaderId: string, kind: PageKind) => void;
  onToggleSplit: (leftIdx: number) => void;
  onPreview: (idx: number) => void;
  onRotate: (item: ImportItem, quarterTurns: number) => void;
  rotatingId: string | null;
  rotatingAll: boolean;
  rotationVersion: Map<string, number>;
  canUngroup: boolean;
  onUngroup: (leader: ImportItem) => void;
  splittingId: string | null;
}) {
  // Map item.id -> its index inside `groupable`, used by the split/merge
  // controls to know which split index they toggle.
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    groupable.forEach((it, i) => m.set(it.id, i));
    return m;
  }, [groupable]);

  return (
    <div className="space-y-3">
      {groups.map((g, gi) => {
        const lastIdx = indexById.get(g[g.length - 1]!.id)!;
        return (
          <div key={g.map((it) => it.id).join('-')} className="space-y-3">
            <RecipeCard
              group={g}
              recipeNumber={gi + 1}
              mode={effectiveKind(g[0]!)}
              thumbSize={thumbSize}
              onSetMode={onSetMode}
              indexById={indexById}
              onPreview={onPreview}
              onToggleSplit={onToggleSplit}
              onRotate={onRotate}
              rotatingId={rotatingId}
              rotatingAll={rotatingAll}
              rotationVersion={rotationVersion}
              canUngroup={canUngroup}
              onUngroup={onUngroup}
              splittingId={splittingId}
            />
            {gi < groups.length - 1 && <MergeDivider onClick={() => onToggleSplit(lastIdx)} />}
          </div>
        );
      })}
    </div>
  );
}

function RecipeCard({
  group,
  recipeNumber,
  mode,
  thumbSize,
  onSetMode,
  indexById,
  onPreview,
  onToggleSplit,
  onRotate,
  rotatingId,
  rotatingAll,
  rotationVersion,
  canUngroup,
  onUngroup,
  splittingId,
}: {
  group: ImportItem[];
  recipeNumber: number;
  mode: PageKind;
  thumbSize: ThumbSize;
  onSetMode: (leaderId: string, kind: PageKind) => void;
  indexById: Map<string, number>;
  onPreview: (idx: number) => void;
  onToggleSplit: (leftIdx: number) => void;
  onRotate: (item: ImportItem, quarterTurns: number) => void;
  rotatingId: string | null;
  rotatingAll: boolean;
  rotationVersion: Map<string, number>;
  canUngroup: boolean;
  onUngroup: (leader: ImportItem) => void;
  splittingId: string | null;
}) {
  const leader = group[0]!;
  const ring =
    mode === 'TOC'
      ? 'ring-2 ring-indigo-400 dark:ring-indigo-500'
      : mode === 'NOTES'
        ? 'ring-2 ring-amber-400 dark:ring-amber-500'
        : 'ring-1 ring-stone-200 dark:ring-stone-700';
  const label = mode === 'TOC' ? 'Contents' : mode === 'NOTES' ? 'Notes' : `Recipe ${recipeNumber}`;
  // A committed multi-page recipe (its absorbed pages are DISCARDED, so they're
  // not in `group`) can be broken apart in reorganize mode via "Ungroup".
  const committedExtraPages = leader.extraStoragePaths.length;
  const showUngroup = canUngroup && committedExtraPages > 0;
  return (
    <div className={`rounded-lg bg-white p-3 dark:bg-stone-900 ${ring}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-stone-700 dark:text-stone-200">
          {label}
          {group.length > 1 && (
            <span className="ml-1 text-xs font-normal text-stone-500 dark:text-stone-400">
              · {group.length} pages
            </span>
          )}
          {showUngroup && (
            <span className="ml-1 text-xs font-normal text-stone-500 dark:text-stone-400">
              · spans {committedExtraPages + 1} pages
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {showUngroup && (
            <button
              type="button"
              onClick={() => onUngroup(leader)}
              disabled={splittingId !== null}
              title="Split this multi-page recipe back into one recipe per page"
              className="rounded-md border border-stone-300 dark:border-stone-600 px-2 py-1 text-xs text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
            >
              {splittingId === leader.id
                ? 'Ungrouping…'
                : `Ungroup (${committedExtraPages + 1} pages)`}
            </button>
          )}
          <ModeToggle value={mode} onChange={(k) => onSetMode(leader.id, k)} />
        </div>
      </div>
      <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
        {group.map((it, ii) => {
          const idxInBatch = indexById.get(it.id)!;
          return (
            <div key={it.id} className="flex items-stretch">
              <PageThumb
                item={it}
                thumbSize={thumbSize}
                pageInGroup={ii + 1}
                groupSize={group.length}
                onPreview={() => onPreview(idxInBatch)}
                onRotate={(turns) => onRotate(it, turns)}
                rotating={rotatingId === it.id || rotatingAll}
                version={rotationVersion.get(it.id) ?? 0}
              />
              {ii < group.length - 1 && <SplitControl onClick={() => onToggleSplit(idxInBatch)} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Segmented Recipe / Contents / Notes control (per recipe group). */
function ModeToggle({
  value,
  onChange,
  tone = 'light',
}: {
  value: PageKind;
  onChange: (kind: PageKind) => void;
  tone?: 'light' | 'dark';
}) {
  const border = tone === 'dark' ? 'border-white/20' : 'border-stone-300 dark:border-stone-600';
  return (
    <div
      role="radiogroup"
      aria-label="Page type"
      className={`inline-flex shrink-0 overflow-hidden rounded-md border ${border}`}
    >
      {KIND_OPTIONS.map((opt) => {
        const active = value === opt.kind;
        const activeCls =
          tone === 'dark'
            ? 'bg-white text-stone-900'
            : 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900';
        const idleCls =
          tone === 'dark'
            ? 'text-white/80 hover:bg-white/10'
            : 'bg-white text-stone-600 hover:bg-stone-100 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800';
        return (
          <button
            key={opt.kind}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.aria}
            onClick={() => onChange(opt.kind)}
            className={`min-h-[36px] px-2.5 text-xs font-medium ${active ? activeCls : idleCls}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function PageThumb({
  item,
  thumbSize,
  pageInGroup,
  groupSize,
  onPreview,
  onRotate,
  rotating,
  version,
}: {
  item: ImportItem;
  thumbSize: ThumbSize;
  pageInGroup: number;
  groupSize: number;
  onPreview: () => void;
  onRotate: (quarterTurns: number) => void;
  rotating: boolean;
  version: number;
}) {
  return (
    <div className={`flex ${THUMB_WIDTH_CLASS[thumbSize]} shrink-0 flex-col items-center gap-1`}>
      <button
        type="button"
        onClick={onPreview}
        title={`View page ${item.pageIndex + 1} fullscreen`}
        aria-label={`View page ${item.pageIndex + 1} fullscreen`}
        className="aspect-[3/4] w-full overflow-hidden rounded border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 hover:border-stone-500 dark:hover:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-400"
      >
        <ImportThumb
          // Remount on rotate so the (cache-busted) thumb re-signs + reloads.
          key={`${item.id}-${version}`}
          path={item.thumbPath ?? item.storagePath}
          alt={`Page ${item.pageIndex + 1}`}
          className="h-full w-full object-cover"
        />
      </button>
      <div className="flex items-center gap-1">
        <RotateButton dir="ccw" disabled={rotating} onClick={() => onRotate(-1)} />
        <span className="text-[11px] leading-tight text-stone-600 dark:text-stone-400">
          Page {item.pageIndex + 1}
          {groupSize > 1 && (
            <span className="ml-1 text-stone-400 dark:text-stone-500">
              ({pageInGroup}/{groupSize})
            </span>
          )}
        </span>
        <RotateButton dir="cw" disabled={rotating} onClick={() => onRotate(1)} />
      </div>
    </div>
  );
}

/** Small ⟲ / ⟳ rotate control. Shared by the cards and the preview. */
function RotateButton({
  dir,
  disabled,
  onClick,
  size = 'sm',
}: {
  dir: 'cw' | 'ccw';
  disabled?: boolean;
  onClick: () => void;
  size?: 'sm' | 'lg';
}) {
  const label = dir === 'cw' ? 'Rotate right' : 'Rotate left';
  const glyph = dir === 'cw' ? '⟳' : '⟲';
  const light =
    'border-stone-300 dark:border-stone-600 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800';
  const dark = 'border-white/20 text-white/90 hover:bg-white/10';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`rounded border ${size === 'lg' ? 'px-3 py-1.5 text-base' : 'px-1 text-xs'} ${
        size === 'lg' ? dark : light
      } disabled:opacity-40`}
    >
      {glyph}
    </button>
  );
}

/** ✂ control between two pages of one recipe — splits them into two recipes. */
function SplitControl({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Split into a new recipe here"
      aria-label="Split into a new recipe here"
      className="mx-0.5 flex shrink-0 items-stretch"
    >
      <span className="flex min-h-[44px] items-center self-stretch rounded bg-stone-100 px-1 text-stone-400 dark:text-stone-500 hover:bg-red-100 hover:text-red-600 dark:bg-stone-800 dark:hover:bg-red-950/40">
        <span aria-hidden className="text-xs">
          ✂
        </span>
      </span>
    </button>
  );
}

/** Full-width control between two recipe cards — merges them into one recipe. */
function MergeDivider({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Merge with next recipe"
      className={`flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-stone-300 py-2 text-xs font-medium text-stone-500 hover:border-sky-400 hover:text-sky-600 dark:border-stone-600 dark:text-stone-400 dark:hover:text-sky-300 ${TAP_TARGET}`}
    >
      <span aria-hidden>⛓</span> Merge with next recipe
    </button>
  );
}

function PagePreviewOverlay({
  item,
  index,
  total,
  orderedItems,
  groups,
  removedSplits,
  leaderKind,
  onSetMode,
  onToggleSplit,
  onRotate,
  rotating,
  rotationVersion,
  version,
  onClose,
  onNavigate,
}: {
  item: ImportItem;
  index: number;
  total: number;
  orderedItems: ImportItem[];
  groups: ImportItem[][];
  removedSplits: Set<number>;
  leaderKind: PageKind;
  onSetMode: (kind: PageKind) => void;
  onToggleSplit: (leftIdx: number) => void;
  onRotate: (quarterTurns: number) => void;
  rotating: boolean;
  rotationVersion: Map<string, number>;
  version: number;
  onClose: () => void;
  onNavigate: (idx: number) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | undefined>();
  const [loadError, setLoadError] = useState(false);

  // Re-fetch when the image changes OR after a rotate (version bump). The
  // signed-URL cache was busted in rotateImportItemImage, so this re-signs
  // and the new token defeats the browser/CDN cache of the old bytes.
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
  }, [item.storagePath, version]);

  // Which recipe (group) this page belongs to, for the footer label.
  const membership = useMemo(() => {
    const gi = groups.findIndex((g) => g.some((it) => it.id === item.id));
    if (gi < 0) return undefined;
    const grp = groups[gi]!;
    const pos = grp.findIndex((it) => it.id === item.id);
    return {
      recipeNumber: gi + 1,
      totalRecipes: groups.length,
      pageInGroup: pos + 1,
      groupSize: grp.length,
    };
  }, [groups, item.id]);

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
      <div className="relative min-h-0 flex-1" onClick={(e) => e.stopPropagation()}>
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

      {/* Thumbnail reel (1b) — jump between pages without leaving the zoom view. */}
      <div
        className="flex shrink-0 gap-1 overflow-x-auto border-t border-white/10 px-3 py-2"
        onClick={(e) => e.stopPropagation()}
      >
        {orderedItems.map((it, idx) => {
          const active = idx === index;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onNavigate(idx)}
              aria-label={`Go to page ${it.pageIndex + 1}`}
              aria-current={active}
              className={`h-16 w-12 shrink-0 overflow-hidden rounded border ${
                active ? 'border-white ring-2 ring-white' : 'border-white/30 hover:border-white/60'
              }`}
            >
              <ImportThumb
                key={`${it.id}-${rotationVersion.get(it.id) ?? 0}`}
                path={it.thumbPath ?? it.storagePath}
                alt={`Page ${it.pageIndex + 1}`}
                className="h-full w-full object-cover"
              />
            </button>
          );
        })}
      </div>

      <div
        className={`flex shrink-0 flex-col gap-2 border-t border-white/10 px-4 py-3 text-sm text-white/90 ${SAFE_BOTTOM}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Page {item.pageIndex + 1} · {index + 1} of {total}
          </span>
          {membership && (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">
              Recipe {membership.recipeNumber} of {membership.totalRecipes}
              {membership.groupSize > 1 &&
                ` · page ${membership.pageInGroup} of ${membership.groupSize}`}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-white/50">Type</span>
          <ModeToggle value={leaderKind} onChange={onSetMode} tone="dark" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-white/50">Rotate</span>
          <RotateButton dir="ccw" size="lg" disabled={rotating} onClick={() => onRotate(-1)} />
          <RotateButton dir="cw" size="lg" disabled={rotating} onClick={() => onRotate(1)} />
          {rotating && <span className="text-xs text-white/60">Rotating…</span>}

          {index > 0 && (
            <button
              type="button"
              onClick={() => onToggleSplit(index - 1)}
              className="rounded-md border border-white/20 px-3 py-1.5 text-xs hover:bg-white/10"
            >
              {removedSplits.has(index - 1)
                ? 'Split from previous page'
                : 'Merge with previous page'}
            </button>
          )}
          {index < total - 1 && (
            <button
              type="button"
              onClick={() => onToggleSplit(index)}
              className="rounded-md border border-white/20 px-3 py-1.5 text-xs hover:bg-white/10"
            >
              {removedSplits.has(index) ? 'Split from next page' : 'Merge with next page'}
            </button>
          )}

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
    </div>
  );
}
