import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ParsedRecipeDraft, RecipeCollection } from '@cookyourbooks/domain';
import { deleteOcrStorage } from '../import/deleteStorage.js';
import { useCollectionPickerOptions } from '../data/queries.js';
import { collectionRepo, recipeRepo } from '../data/repos.js';
import {
  buildRecipeFromDraft,
  isAutoAcceptable,
  resolveTargetRecipe,
} from '../import/promoteDraft.js';
import {
  useImportBatch,
  useImportItems,
  useUpdateImportBatch,
  useUpdateImportItem,
} from '../import/queries.js';
import {
  kickOcr,
  mergeImportItems,
  OcrWorkerNotConfiguredError,
  retryRecitationFailures,
  setBatchFallback,
  setImportItemToc,
  setRecitationPolicy,
} from '../import/api.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../settings/ocrSettings.js';
import type { OcrProvider } from '../import/model.js';
import { useLocalQueryEnabled, useSync } from '../local/SyncProvider.js';
import { ImportThumb } from '../import/ImportThumb.js';
import { CookbookCombobox } from '../import/CookbookCombobox.js';
import { LocalImportItemRepository } from '../import/localRepos.js';
import {
  compactOcrQueueLabel,
  computeBatchQueueInfo,
  isOcrInProgress,
} from '../import/ocrStatus.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportItem, ImportItemStatus } from '../import/model.js';

// Auto-accept of obviously-good OCR pages is on by default; power users can
// turn it off per device. Stored as '0' (off) / anything-else (on).
const AUTO_ACCEPT_KEY = 'cookyourbooks.import.autoAccept';
function readAutoAcceptPref(): boolean {
  try {
    return localStorage.getItem(AUTO_ACCEPT_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeAutoAcceptPref(on: boolean): void {
  try {
    localStorage.setItem(AUTO_ACCEPT_KEY, on ? '1' : '0');
  } catch {
    /* private mode / storage disabled — fall back to in-memory only */
  }
}

/** A recipe the auto-accept pass created, retained so Undo can reverse it. */
interface AutoAcceptedEntry {
  itemId: string;
  recipeId: string;
  collectionId: string;
  /** The drafts that were on the item, restored to it on Undo. */
  drafts: ParsedRecipeDraft[];
}

/** Merge-absorbed pages are marked DISCARDED with their storage_path folded
 *  into another item's extras; they already show under that primary's
 *  "spans N pages" badge, so hide them from the grid + counts. */
function isMergeAbsorbed(item: ImportItem, absorbedPaths: Set<string>): boolean {
  return item.status === 'DISCARDED' && absorbedPaths.has(item.storagePath);
}

type Filter =
  | 'ALL'
  | 'PENDING'
  | 'PROCESSING'
  | 'DONE'
  | 'NEEDS_REVIEW'
  | 'FAILED'
  | 'TOC'
  | 'NOTES';

function matchesFilter(item: ImportItem, filter: Filter): boolean {
  switch (filter) {
    case 'ALL':
      return true;
    case 'PENDING':
      return item.status === 'PENDING';
    case 'PROCESSING':
      return item.status === 'CLAIMED';
    case 'DONE':
      return item.status === 'REVIEWED';
    case 'NEEDS_REVIEW':
      return item.status === 'OCR_DONE' || item.status === 'NEEDS_FALLBACK' || item.status === 'BAKEOFF_READY';
    case 'FAILED':
      return item.status === 'OCR_FAILED';
    case 'TOC':
      return item.kind === 'TOC';
    case 'NOTES':
      return item.kind === 'NOTES';
  }
}

export function ImportBatchPage() {
  const { batchId } = useParams();
  const { user } = useAuth();
  const { syncNow, status: syncStatus, localReady, hydrated } = useSync();
  const { data: batch, isLoading: batchLoading } = useImportBatch(batchId);
  const { data: items = [] } = useImportItems(batchId);
  const { data: pickerOptions = [] } = useCollectionPickerOptions();
  const updateBatch = useUpdateImportBatch();
  const updateItem = useUpdateImportItem();
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [recitationBusy, setRecitationBusy] = useState(false);
  const [kickBusy, setKickBusy] = useState(false);
  const [kickError, setKickError] = useState<string | undefined>();
  const [editingFallback, setEditingFallback] = useState(false);
  const [fallbackDraft, setFallbackDraft] = useState<{
    provider: '' | OcrProvider;
    model: string;
  }>({ provider: '', model: '' });
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [fallbackError, setFallbackError] = useState<string | undefined>();
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryToast, setRetryToast] = useState<string | undefined>();

  const qc = useQueryClient();
  // Auto-accept bookkeeping. `processedRef` is the set of item ids the pass
  // has already claimed (so it never double-promotes, and undone items stay
  // out of the pass). `runningRef` serializes passes — `items` changes as we
  // promote, which re-triggers the effect mid-flight.
  const processedRef = useRef<Set<string>>(new Set());
  const runningRef = useRef(false);
  const [autoAcceptOn, setAutoAcceptOn] = useState(readAutoAcceptPref);
  const [autoAccepted, setAutoAccepted] = useState<AutoAcceptedEntry[]>([]);
  const [autoAcceptError, setAutoAcceptError] = useState<string | undefined>();

  const localQueryEnabled = useLocalQueryEnabled();
  const { data: attemptsByItem = {} } = useQuery<Record<string, number[]>>({
    queryKey: ['import-batch-rates', batchId],
    enabled: localQueryEnabled && !!batchId && items.length > 0,
    queryFn: async () => {
      const repo = new LocalImportItemRepository(user!.id);
      const out: Record<string, number[]> = {};
      for (const item of items) {
        const a = await repo.listAttempts(item.id);
        out[item.id] = a
          .filter((x) => x.finishedAt != null)
          .map((x) => x.finishedAt!);
      }
      return out;
    },
  });

  const collectionsById = useMemo(
    () => new Map(pickerOptions.map((c) => [c.id, c])),
    [pickerOptions],
  );

  const totalCost = items.reduce((acc, i) => acc + i.costUsdMicros, 0) / 1_000_000;

  const needsFallbackCount = items.filter((i) => i.status === 'NEEDS_FALLBACK').length;
  const recitationFailedCount = items.filter(
    (i) =>
      i.status === 'OCR_FAILED' &&
      (i.lastError ?? '').toLowerCase().includes('recitation'),
  ).length;

  const { itemsPerMin, eta } = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    let recent = 0;
    let totalLatency = 0;
    let completed = 0;
    for (const finishes of Object.values(attemptsByItem)) {
      for (const t of finishes) {
        if (t >= cutoff) recent += 1;
        completed += 1;
        totalLatency += 1;
      }
    }
    const perMin = recent;
    const remaining = items.filter(
      (i) => i.status === 'PENDING' || i.status === 'CLAIMED',
    ).length;
    const avgPerItemSecs = completed > 0 && perMin > 0 ? 60 / perMin : 0;
    const etaSecs = remaining * avgPerItemSecs;
    return {
      itemsPerMin: perMin,
      eta: etaSecs > 0 && Number.isFinite(etaSecs) ? formatEta(etaSecs) : '—',
    };
  }, [attemptsByItem, items]);

  useEffect(() => {
    if (batch && !editingName) setNameDraft(batch.name);
  }, [batch, editingName]);

  // Auto-accept pass: promote obviously-good pages to recipes without a
  // click (Conservative bar in `isAutoAcceptable`). Recipes are created in
  // the browser anyway (local-first), so this just runs the same promote
  // logic the manual path uses. Bakeoff batches are skipped — there the user
  // is actively comparing variants. `runningRef` serializes; `processedRef`
  // dedupes across the re-renders each promotion triggers.
  useEffect(() => {
    if (!autoAcceptOn || !batch || !user) return;
    if (batch.batchKind !== 'STANDARD') return;
    if (runningRef.current) return;
    const candidates = items.filter(
      (i) =>
        !processedRef.current.has(i.id) &&
        isAutoAcceptable(i, batch.targetCollectionId),
    );
    if (candidates.length === 0) return;
    // Claim synchronously before any await so a re-render can't re-grab them.
    for (const c of candidates) processedRef.current.add(c.id);
    runningRef.current = true;
    const ownerId = user.id;
    const targetDefault = batch.targetCollectionId;
    void (async () => {
      const collCache = new Map<string, RecipeCollection | undefined>();
      const accepted: AutoAcceptedEntry[] = [];
      try {
        for (const it of candidates) {
          const targetId = it.assignedCollectionId ?? targetDefault!;
          if (!collCache.has(targetId)) {
            collCache.set(targetId, await collectionRepo(ownerId).get(targetId));
          }
          const collection = collCache.get(targetId);
          const draft = it.parsedDrafts[0]!;
          const { recipeId, overwriteTitle } = resolveTargetRecipe(draft, it, collection);
          const recipe = buildRecipeFromDraft(draft, {
            collectionTitle: collection?.title,
            recipeId,
            overwriteTitle,
          });
          await recipeRepo(targetId).save(recipe);
          await updateItem.mutateAsync({
            id: it.id,
            patch: {
              parsedDrafts: [],
              createdRecipeIds: [...(it.createdRecipeIds ?? []), recipe.id],
              assignedCollectionId: targetId,
              status: 'REVIEWED',
            },
          });
          accepted.push({
            itemId: it.id,
            recipeId: recipe.id,
            collectionId: targetId,
            drafts: it.parsedDrafts,
          });
        }
        qc.invalidateQueries({ queryKey: ['collections', ownerId] });
        qc.invalidateQueries({ queryKey: ['library-summaries', ownerId] });
        qc.invalidateQueries({ queryKey: ['recipe-search'] });
        await syncNow();
        if (accepted.length > 0) setAutoAccepted((prev) => [...prev, ...accepted]);
      } catch (e) {
        setAutoAcceptError((e as Error).message);
      } finally {
        runningRef.current = false;
      }
    })();
  }, [autoAcceptOn, batch, items, user, qc, syncNow, updateItem]);

  const pendingCount = items.filter((i) => i.status === 'PENDING').length;
  const stalledCount = items.filter((i) => i.status === 'CLAIMED').length;
  const awaitingGroupingCount = items.filter(
    (i) => i.status === 'AWAITING_GROUPING',
  ).length;
  const activeOcrCount = pendingCount + stalledCount;
  const now = useTickingNow(activeOcrCount > 0);

  if (!localReady || batchLoading) {
    return <p className="text-stone-500 dark:text-stone-400">Loading…</p>;
  }
  if (!batch && !hydrated) {
    return <p className="text-stone-500 dark:text-stone-400">Initializing local cache…</p>;
  }
  if (!batch) {
    return (
      <div className="space-y-3">
        <p className="text-stone-700 dark:text-stone-300">Batch not found locally.</p>
        <p className="text-sm text-stone-500 dark:text-stone-400">
          It may not have synced from the server yet ({syncStatus}).
        </p>
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

  const absorbedPaths = new Set(items.flatMap((i) => i.extraStoragePaths));
  const filtered = items.filter(
    (i) => matchesFilter(i, filter) && !isMergeAbsorbed(i, absorbedPaths),
  );

  function toggleSelect(id: string, e: React.MouseEvent) {
    if (e.shiftKey || (e as unknown as MouseEvent).metaKey) {
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      e.preventDefault();
    }
  }

  async function applyBulk(
    patch: Parameters<typeof updateItem.mutateAsync>[0]['patch'],
  ) {
    for (const id of selected) {
      await updateItem.mutateAsync({ id, patch });
    }
    setSelected(new Set());
  }

  function toggleAutoAccept() {
    setAutoAcceptOn((on) => {
      const next = !on;
      writeAutoAcceptPref(next);
      return next;
    });
  }

  // Reverse the auto-accepted recipes: delete each created recipe and put its
  // item back in Needs review with its drafts restored. The items stay in
  // `processedRef` so the pass doesn't immediately re-accept them — Undo
  // means "I'll review these by hand".
  async function undoAutoAccepts() {
    const entries = autoAccepted;
    if (entries.length === 0) return;
    setAutoAccepted([]);
    setAutoAcceptError(undefined);
    try {
      for (const e of entries) {
        await recipeRepo(e.collectionId).delete(e.recipeId);
        const cur = items.find((i) => i.id === e.itemId);
        await updateItem.mutateAsync({
          id: e.itemId,
          patch: {
            parsedDrafts: e.drafts,
            status: 'OCR_DONE',
            createdRecipeIds: (cur?.createdRecipeIds ?? []).filter((id) => id !== e.recipeId),
          },
        });
      }
      if (user) {
        qc.invalidateQueries({ queryKey: ['collections', user.id] });
        qc.invalidateQueries({ queryKey: ['library-summaries', user.id] });
        qc.invalidateQueries({ queryKey: ['recipe-search'] });
      }
      await syncNow();
    } catch (err) {
      setAutoAcceptError(`Undo failed: ${(err as Error).message}`);
    }
  }

  // Flagging pages as ToC has to re-run OCR, which means a server-side
  // reset to PENDING — the outbox push scrub drops any client status
  // change that isn't REVIEWED / DISCARDED, so the plain bulk-patch path
  // (isToc + status PENDING) never reached the worker. Go through the
  // same RPC the single-item toggle uses, then kick the worker.
  async function markSelectedAsToc() {
    if (!batch || selected.size === 0) return;
    const ids = [...selected];
    try {
      for (const id of ids) {
        await setImportItemToc(id, true);
      }
      await syncNow();
      try {
        await kickOcr(batch.id);
      } catch {
        // pg_cron / the next kick will pick up the slack.
      }
      setSelected(new Set());
    } catch (e) {
      alert(`Couldn't re-OCR the selected pages as ToC: ${(e as Error).message}`);
    }
  }

  async function applyRecitation(policy: 'FALLBACK' | 'FAIL') {
    if (!batch) return;
    setRecitationBusy(true);
    try {
      await setRecitationPolicy(batch.id, policy);
      await updateBatch.mutateAsync({
        id: batch.id,
        patch: { recitationPolicy: policy },
      });
      // FALLBACK moves the parked items back to PENDING server-side.
      // Kick the worker so they're picked up immediately instead of
      // waiting for the next 30s pg_cron tick. (FAIL drops them to
      // OCR_FAILED — no point kicking.)
      if (policy === 'FALLBACK') {
        try {
          await kickOcr(batch.id);
        } catch {
          // Cron will catch up if the kick fails.
        }
      }
    } finally {
      setRecitationBusy(false);
    }
  }

  function openFallbackEditor() {
    if (!batch) return;
    setFallbackError(undefined);
    setFallbackDraft({
      provider: batch.fallbackProvider ?? '',
      model: batch.fallbackModel ?? '',
    });
    setEditingFallback(true);
  }

  async function saveFallback() {
    if (!batch) return;
    setFallbackError(undefined);
    const provider = fallbackDraft.provider || null;
    const rawModel = fallbackDraft.model.trim();
    const model = provider ? rawModel || DEFAULT_MODEL_BY_PROVIDER[provider] : null;
    if ((provider === null) !== (model === null)) {
      setFallbackError('Provider and model must both be set or both cleared.');
      return;
    }
    setFallbackBusy(true);
    try {
      await setBatchFallback(batch.id, provider, model);
      // Mirror into the local cache immediately so the UI doesn't wait
      // for the realtime round-trip. The outbox path isn't used here
      // because we want this write to be server-confirmed before the
      // user can click "Retry with fallback".
      await updateBatch.mutateAsync({
        id: batch.id,
        patch: { fallbackProvider: provider, fallbackModel: model },
      });
      setEditingFallback(false);
    } catch (e) {
      setFallbackError((e as Error).message);
    } finally {
      setFallbackBusy(false);
    }
  }

  async function retryFailedWithFallback() {
    if (!batch) return;
    setRetryBusy(true);
    setRetryToast(undefined);
    try {
      const n = await retryRecitationFailures(batch.id);
      // Mirror policy locally so the FAIL→FALLBACK transition is
      // visible before the next pull.
      await updateBatch.mutateAsync({
        id: batch.id,
        patch: { recitationPolicy: 'FALLBACK' },
      });
      try {
        await kickOcr(batch.id);
      } catch {
        /* cron will catch up */
      }
      await syncNow();
      setRetryToast(
        n === 0
          ? 'No recitation-failed items to retry.'
          : `Retrying ${n} item${n === 1 ? '' : 's'} with fallback model.`,
      );
    } catch (e) {
      setRetryToast(`Retry failed: ${(e as Error).message}`);
    } finally {
      setRetryBusy(false);
    }
  }

  async function kickWorker() {
    if (!batch) return;
    setKickBusy(true);
    setKickError(undefined);
    try {
      await kickOcr(batch.id);
      await syncNow();
    } catch (e) {
      if (e instanceof OcrWorkerNotConfiguredError) {
        setKickError(
          'OCR worker is not configured for this Supabase project. See CLAUDE.md → "Setting up the OCR worker".',
        );
      } else {
        setKickError((e as Error).message);
      }
    } finally {
      setKickBusy(false);
    }
  }

  const movedCount = items.filter(
    (i) =>
      i.status === 'OCR_DONE' ||
      i.status === 'OCR_FAILED' ||
      i.status === 'NEEDS_FALLBACK' ||
      i.status === 'REVIEWED' ||
      i.status === 'DISCARDED',
  ).length;
  const batchAgeMs = Date.now() - batch.updatedAt;
  // After 30s with pending items and no observable progress, the worker
  // probably isn't reachable. Surface a kick + a setup pointer.
  const showStuckBanner =
    pendingCount > 0 &&
    movedCount === 0 &&
    stalledCount === 0 &&
    batchAgeMs > 30_000;

  return (
    <div className="space-y-6 pb-20">
      {awaitingGroupingCount > 0 && (
        <div className="sticky top-0 z-10 rounded-md border border-violet-300 bg-violet-50 p-3 text-sm text-violet-900">
          <div className="font-medium">
            {awaitingGroupingCount} page{awaitingGroupingCount === 1 ? '' : 's'} waiting
            for grouping
          </div>
          <div className="mt-1 text-violet-800">
            This batch was uploaded as "Group then OCR". Decide which pages go
            together — OCR runs once you confirm.
          </div>
          <div className="mt-2">
            <Link
              to={`/import/${batch.id}/group`}
              className="inline-block rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
            >
              Group pages
            </Link>
          </div>
        </div>
      )}

      {autoAccepted.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-3 rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 p-3 text-sm text-emerald-900 dark:text-emerald-200"
        >
          <span className="font-medium">
            ✓ {autoAccepted.length} recipe{autoAccepted.length === 1 ? '' : 's'} auto-accepted
          </span>
          <span className="text-emerald-800 dark:text-emerald-300">
            High-confidence pages were saved for you — only pages that need a look stay
            in “Needs review”.
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => void undoAutoAccepts()}
              className="rounded-md border border-emerald-400 dark:border-emerald-600 px-3 py-1 text-xs font-medium hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => setAutoAccepted([])}
              className="rounded-md px-3 py-1 text-xs hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {autoAcceptError && (
        <div className="rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/40 p-2 text-xs text-red-800 dark:text-red-200">
          Auto-accept hit a problem: {autoAcceptError}
        </div>
      )}

      {showStuckBanner && (
        <div className="rounded-md border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-900 p-3 text-sm text-stone-800 dark:text-stone-200">
          <div className="font-medium">
            {pendingCount} item{pendingCount === 1 ? '' : 's'} queued — worker hasn't
            picked them up.
          </div>
          <div className="mt-1 text-stone-600 dark:text-stone-400">
            Pending = uploaded and waiting for the OCR worker. If this doesn't
            clear, the worker may not be configured or running. See CLAUDE.md →
            "Setting up the OCR worker".
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={kickWorker}
              disabled={kickBusy}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
            >
              {kickBusy ? 'Kicking…' : 'Process now'}
            </button>
          </div>
          {kickError && (
            <div className="mt-2 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/40 p-2 text-xs text-red-800 dark:text-red-200">
              {kickError}
            </div>
          )}
        </div>
      )}

      {recitationFailedCount > 0 && batch.recitationPolicy !== 'ASK' && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="font-medium">
            {recitationFailedCount} item{recitationFailedCount === 1 ? '' : 's'} failed
            on recitation.
          </div>
          <div className="mt-1">
            {batch.fallbackProvider && batch.fallbackModel ? (
              <>Retry with fallback model ({batch.fallbackModel})?</>
            ) : (
              <>Set a fallback model above first, then retry.</>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void retryFailedWithFallback()}
              disabled={
                retryBusy || !batch.fallbackProvider || !batch.fallbackModel
              }
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
            >
              {retryBusy ? 'Retrying…' : 'Retry with fallback'}
            </button>
            {retryToast && (
              <span className="self-center text-xs">{retryToast}</span>
            )}
          </div>
        </div>
      )}

      {needsFallbackCount > 0 && batch.recitationPolicy === 'ASK' && (
        <div className="sticky top-0 z-10 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="font-medium">
            {needsFallbackCount} item{needsFallbackCount === 1 ? '' : 's'} hit copyright
            recitation.
          </div>
          <div className="mt-1">
            Use fallback model{batch.fallbackModel ? ` (${batch.fallbackModel})` : ''}?
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => applyRecitation('FALLBACK')}
              disabled={recitationBusy}
              className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
            >
              Yes, use fallback
            </button>
            <button
              type="button"
              onClick={() => applyRecitation('FAIL')}
              disabled={recitationBusy}
              className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-60"
            >
              No, mark them failed
            </button>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-2">
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={async () => {
                if (nameDraft.trim() !== batch.name) {
                  await updateBatch.mutateAsync({
                    id: batch.id,
                    patch: { name: nameDraft.trim() },
                  });
                }
                setEditingName(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setNameDraft(batch.name);
                  setEditingName(false);
                }
              }}
              className="w-full rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-2xl font-semibold"
            />
          ) : (
            <h1
              tabIndex={0}
              role="button"
              onClick={() => setEditingName(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setEditingName(true);
              }}
              className="cursor-text rounded text-2xl font-semibold hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              {batch.name || '(untitled)'}
            </h1>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
            <span className="text-sm">Target cookbook:</span>
            <div className="min-w-[18rem]">
              <CookbookCombobox
                options={pickerOptions}
                value={batch.targetCollectionId ?? ''}
                onChange={(id) =>
                  updateBatch.mutate({
                    id: batch.id,
                    patch: { targetCollectionId: id || null },
                  })
                }
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
            <span>Fallback model:</span>
            {editingFallback ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  value={fallbackDraft.provider}
                  onChange={(e) =>
                    setFallbackDraft((d) => ({
                      ...d,
                      provider: e.target.value as '' | OcrProvider,
                      model:
                        e.target.value && !d.model
                          ? DEFAULT_MODEL_BY_PROVIDER[e.target.value as OcrProvider]
                          : d.model,
                    }))
                  }
                  className="rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-sm"
                >
                  <option value="">(none)</option>
                  <option value="gemini">gemini</option>
                  <option value="openai-compatible">openai-compatible</option>
                </select>
                {fallbackDraft.provider && (
                  <input
                    value={fallbackDraft.model}
                    onChange={(e) =>
                      setFallbackDraft((d) => ({ ...d, model: e.target.value }))
                    }
                    placeholder={DEFAULT_MODEL_BY_PROVIDER[fallbackDraft.provider]}
                    className="rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-sm"
                  />
                )}
                <button
                  type="button"
                  onClick={() => void saveFallback()}
                  disabled={fallbackBusy}
                  className="rounded-md bg-stone-900 dark:bg-stone-100 px-2 py-1 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60"
                >
                  {fallbackBusy ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingFallback(false)}
                  className="rounded-md border border-stone-300 dark:border-stone-600 px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-800"
                >
                  Cancel
                </button>
                {fallbackError && (
                  <span className="text-xs text-red-700 dark:text-red-300">{fallbackError}</span>
                )}
              </div>
            ) : (
              <>
                <span>
                  {batch.fallbackProvider && batch.fallbackModel
                    ? `${batch.fallbackModel} (${batch.fallbackProvider})`
                    : 'not configured'}
                </span>
                <button
                  type="button"
                  onClick={openFallbackEditor}
                  className="rounded-md border border-stone-300 dark:border-stone-600 px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-800"
                >
                  Edit
                </button>
              </>
            )}
          </div>
        </div>
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800">
            …
          </summary>
          <div className="absolute right-0 mt-1 w-64 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-1 text-sm shadow-md">
            <button
              type="button"
              onClick={() =>
                updateBatch.mutate({
                  id: batch.id,
                  patch: { status: batch.status === 'ARCHIVED' ? 'OPEN' : 'ARCHIVED' },
                })
              }
              className="block w-full rounded px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              {batch.status === 'ARCHIVED' ? 'Unarchive batch' : 'Archive batch'}
            </button>
            <BatchDeleteStorageButton batchId={batch.id} />
          </div>
        </details>
      </div>

      {activeOcrCount > 0 && (
        <p className="text-sm text-stone-600 dark:text-stone-400" role="status">
          {stalledCount > 0 && (
            <>
              <strong>{stalledCount}</strong> processing
              {pendingCount > 0 ? ' · ' : ''}
            </>
          )}
          {pendingCount > 0 && (
            <>
              <strong>{pendingCount}</strong> queued for OCR
            </>
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ['ALL', 'All'],
            ['PENDING', 'Pending'],
            ['PROCESSING', 'Processing'],
            ['NEEDS_REVIEW', 'Needs review'],
            ['DONE', 'Done'],
            ['FAILED', 'Failed'],
            ['TOC', 'ToC'],
            ['NOTES', 'Notes'],
          ] as Array<[Filter, string]>
        ).map(([key, label]) => {
          const count = items.filter(
            (i) => matchesFilter(i, key) && !isMergeAbsorbed(i, absorbedPaths),
          ).length;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded-full border px-3 py-1 text-xs ${
                filter === key
                  ? 'border-stone-900 bg-stone-900 text-white'
                  : 'border-stone-300 text-stone-700 hover:bg-stone-100'
              }`}
            >
              {label} <span className="opacity-70">({count})</span>
            </button>
          );
        })}
        <label
          className="ml-auto flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-400"
          title="Automatically save pages whose OCR result is unambiguous: a single recipe with a clear title, at least 3 ingredients and 2 steps, and nothing the parser couldn't read. You can Undo, or turn this off."
        >
          <input
            type="checkbox"
            checked={autoAcceptOn}
            onChange={toggleAutoAccept}
            className="h-3.5 w-3.5"
          />
          Auto-accept obvious recipes
        </label>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-900 p-2 text-sm">
          <span>{selected.size} selected</span>
          <button
            type="button"
            onClick={() => void markSelectedAsToc()}
            className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Mark as ToC
          </button>
          <button
            type="button"
            onClick={() => applyBulk({ status: 'DISCARDED' })}
            className="rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-stone-900 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            Discard
          </button>
          <ReassignBulkButton onApply={(collectionId) => applyBulk({ assignedCollectionId: collectionId })} />
          {selected.size === 1 && (
            <span className="text-xs italic text-stone-500 dark:text-stone-400">
              Select one more page to merge them into one recipe →
            </span>
          )}
          {selected.size >= 2 && (
            <button
              type="button"
              onClick={async () => {
                if (!batch) return;
                // Use the lowest page_index as the primary so the
                // result lands on the earlier scan; absorb the rest.
                const chosen = items
                  .filter((i) => selected.has(i.id))
                  .sort((a, b) => a.pageIndex - b.pageIndex);
                const primary = chosen[0];
                if (!primary || chosen.length < 2) return;
                const absorb = chosen.slice(1).map((i) => i.id);
                const plural = absorb.length === 1 ? 'page' : 'pages';
                if (
                  !confirm(
                    `Merge ${absorb.length} extra ${plural} onto page ${primary.pageIndex + 1} and re-run OCR with all images together?`,
                  )
                ) {
                  return;
                }
                try {
                  await mergeImportItems(primary.id, absorb);
                  try {
                    await kickOcr(batch.id);
                  } catch {
                    /* cron will pick it up */
                  }
                  setSelected(new Set());
                } catch (e) {
                  alert(`Merge failed: ${(e as Error).message}`);
                }
              }}
              className="rounded-md border border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-1 text-xs font-medium text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
              title="Combine selected scans into one item and re-OCR with all images at once. Useful when a recipe spans a page break and the worker split it into two items."
            >
              Merge {selected.size} pages into one item
            </button>
          )}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Clear
          </button>
        </div>
      )}

      {selected.size === 0 && filtered.length > 1 && (
        <div className="flex items-start gap-2 rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900 px-3 py-2 text-xs text-stone-600 dark:text-stone-400">
          <span aria-hidden className="mt-px text-sm leading-none">⧉</span>
          <span>
            <strong className="font-medium text-stone-700 dark:text-stone-200">
              Pages split wrong?
            </strong>{' '}
            Tick the checkbox on two or more scans to{' '}
            <strong className="font-medium text-stone-700 dark:text-stone-200">merge</strong> them
            into one recipe — they re-OCR together, so this fixes a recipe the scanner split across
            a page break. You can also reassign the cookbook or discard selected pages.
          </span>
        </div>
      )}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {filtered.map((item) => {
          const titles = item.parsedDrafts
            .map((d) => d.title?.trim())
            .filter((t): t is string => !!t);
          const recipeCount = item.parsedDrafts.length;
          const spansPages =
            item.extraStoragePaths.length > 0 ? item.extraStoragePaths.length + 1 : 0;
          const isSelected = selected.has(item.id);
          const queueInfo = isOcrInProgress(item.status)
            ? computeBatchQueueInfo(item, items, now)
            : null;
          const queueLabel = queueInfo ? compactOcrQueueLabel(queueInfo) : null;
          return (
            <li key={item.id} className="relative">
              <label
                className="absolute left-1.5 top-1.5 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-stone-300 dark:border-stone-600 bg-white/95 shadow-sm hover:border-stone-500"
                title="Select for bulk action"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {
                    setSelected((cur) => {
                      const next = new Set(cur);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    });
                  }}
                  className="h-3.5 w-3.5 cursor-pointer"
                  aria-label={`Select page ${item.pageIndex + 1}`}
                />
              </label>
              <Link
                to={`/import/${batch.id}/items/${item.id}`}
                onClick={(e) => toggleSelect(item.id, e)}
                className={`block overflow-hidden rounded-lg border ${
                  isSelected
                    ? 'border-stone-900 ring-2 ring-stone-900'
                    : 'border-stone-200 hover:border-stone-400'
                } bg-white`}
              >
                <ImportThumb
                  path={item.thumbPath}
                  alt={`Page ${item.pageIndex + 1}`}
                  className="aspect-[3/4] w-full object-cover"
                />
                <div className="space-y-1 p-2">
                  <div className="flex items-center justify-between gap-1">
                    <span className="flex flex-wrap items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
                      #{item.pageIndex + 1}
                      {spansPages > 0 && (
                        <span
                          className="rounded-full bg-sky-100 dark:bg-sky-900/50 px-1.5 text-[10px] font-medium text-sky-800 dark:text-sky-200"
                          title={`This recipe was read from ${spansPages} scanned pages together`}
                        >
                          spans {spansPages} pages
                        </span>
                      )}
                      {recipeCount > 1 && (
                        <span
                          className="rounded-full bg-indigo-100 dark:bg-indigo-900/50 px-1.5 text-[10px] font-semibold text-indigo-800 dark:text-indigo-200"
                          title={`${recipeCount} recipes were extracted from this page`}
                        >
                          {recipeCount} recipes
                        </span>
                      )}
                    </span>
                    <ItemStatusPill status={item.status} />
                  </div>
                  {queueLabel && (
                    <div className="text-[10px] leading-tight text-stone-600 dark:text-stone-400">{queueLabel}</div>
                  )}
                  {titles.length > 0 ? (
                    <ul className="space-y-0.5">
                      {titles.slice(0, 3).map((t, i) => (
                        <li
                          key={i}
                          className="truncate text-xs font-medium text-stone-800 dark:text-stone-200"
                          title={t}
                        >
                          {t}
                        </li>
                      ))}
                      {titles.length > 3 && (
                        <li className="text-[10px] text-stone-500 dark:text-stone-400">
                          +{titles.length - 3} more
                        </li>
                      )}
                    </ul>
                  ) : recipeCount > 0 ? (
                    <div className="truncate text-xs italic text-stone-500 dark:text-stone-400">
                      (untitled recipe)
                    </div>
                  ) : null}
                  {item.kind === 'TOC' && (
                    <div className="text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                      Table of Contents
                    </div>
                  )}
                  {item.kind === 'NOTES' && (
                    <div className="text-[10px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
                      Notes
                    </div>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {filtered.length === 0 && (
        <p className="text-stone-600 dark:text-stone-400">No items match this filter.</p>
      )}

      <div className="fixed inset-x-0 bottom-0 border-t border-stone-200 dark:border-stone-700 bg-white/95 px-4 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-400">
          <span>
            Total cost: <strong>${totalCost.toFixed(2)}</strong>
          </span>
          <span>
            Throughput: <strong>{itemsPerMin}</strong> items/min
          </span>
          <span>
            ETA: <strong>{eta}</strong>
          </span>
          <span className="ml-auto text-stone-500 dark:text-stone-400">
            <Link to="/import" className="underline">
              ← All batches
            </Link>
          </span>
        </div>
      </div>
    </div>
  );

  function ReassignBulkButton({ onApply }: { onApply: (id: string | null) => void }) {
    return (
      <select
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value;
          e.target.value = '';
          if (v === '__unassign__') onApply(null);
          else if (v) onApply(v);
        }}
        className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-xs"
      >
        <option value="">Reassign…</option>
        <option value="__unassign__">(unassigned)</option>
        {pickerOptions.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
    );
  }
}

function ItemStatusPill({ status }: { status: ImportItemStatus }) {
  const map: Record<ImportItemStatus, { label: string; cls: string }> = {
    AWAITING_GROUPING: { label: 'Awaiting grouping', cls: 'bg-violet-100 text-violet-800' },
    BAKEOFF_PENDING: { label: 'Running variants', cls: 'bg-blue-100 text-blue-800' },
    BAKEOFF_READY: { label: 'Pick winner', cls: 'bg-violet-100 text-violet-800' },
    PENDING: { label: 'Queued', cls: 'bg-stone-200 text-stone-700' },
    CLAIMED: { label: 'Processing', cls: 'bg-blue-100 text-blue-800' },
    OCR_DONE: { label: 'Needs review', cls: 'bg-amber-100 text-amber-800' },
    NEEDS_FALLBACK: { label: 'Needs fallback', cls: 'bg-orange-100 text-orange-800' },
    OCR_FAILED: { label: 'Failed', cls: 'bg-red-100 text-red-800' },
    REVIEWED: { label: 'Reviewed', cls: 'bg-emerald-100 text-emerald-800' },
    DISCARDED: { label: 'Discarded', cls: 'bg-stone-100 text-stone-500' },
  };
  const { label, cls } = map[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function useTickingNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * Menu item that wipes every uploaded image in this batch from storage
 * (keeps the OCR'd drafts and any promoted recipes — only the source
 * pictures go away). Shows a confirm dialog because the deletion is
 * not reversible.
 */
function BatchDeleteStorageButton({ batchId }: { batchId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { syncNow } = useSync();

  async function onClick() {
    if (
      !confirm(
        'Delete every uploaded image in this batch? Recipes you already promoted will stay. This cannot be undone.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteOcrStorage({ kind: 'batch', batchId });
      await syncNow();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        data-testid="batch-delete-storage"
        className="block w-full rounded px-3 py-1.5 text-left text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-60"
      >
        {busy ? 'Deleting images…' : 'Delete all uploaded images'}
      </button>
      {error && (
        <p className="px-3 py-1 text-xs text-red-700 dark:text-red-300">{error}</p>
      )}
    </>
  );
}
