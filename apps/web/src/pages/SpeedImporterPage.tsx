import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Recipe, RecipeCollection } from '@cookyourbooks/domain';
import { useAuth } from '../auth/AuthProvider.js';
import { useCollection, useCollections } from '../data/queries.js';
import { useImportItems, useOcrKeys } from '../import/queries.js';
import {
  addPlannedShot,
  discardPlannedShot,
  ensurePlannerBatch,
  finalizePlannerSession,
  type PlannedShotTarget,
} from '../import/plannerUpload.js';
import { plannerHapticTick, plannerShutter } from '../import/plannerCapture.js';
import { findOpenPlannerSession } from '../import/localRepos.js';
import { ImportThumb } from '../import/ImportThumb.js';
import type { ImportBatch, ImportItem } from '../import/model.js';
import { useSync } from '../local/SyncProvider.js';
import { useQueryClient } from '@tanstack/react-query';

type Phase = 'pick' | 'capture' | 'review' | 'finalizing';

export function SpeedImporterPage() {
  const [searchParams] = useSearchParams();
  const queryCollectionId = searchParams.get('collection') ?? undefined;
  const navigate = useNavigate();
  const { user } = useAuth();
  const { syncNow } = useSync();
  const qc = useQueryClient();
  const { data: collections = [] } = useCollections();
  const { data: ocrKeys = [] } = useOcrKeys();
  const [collectionId, setCollectionId] = useState<string | undefined>(queryCollectionId);
  const [phase, setPhase] = useState<Phase>(queryCollectionId ? 'capture' : 'pick');
  const { data: collection } = useCollection(collectionId);

  // The open session, if any. Set on entry / refreshed after a shutter
  // succeeds. `batchRef` mirrors the value for callbacks so a fast
  // double-tap doesn't lose the freshly-minted batch id between
  // re-renders.
  const [batch, setBatch] = useState<ImportBatch | undefined>();
  const batchRef = useRef<ImportBatch | undefined>(undefined);
  useEffect(() => {
    batchRef.current = batch;
  }, [batch]);

  // Try to resume on entry. Failing silently is fine — first shutter
  // will create one if absent.
  useEffect(() => {
    if (!user || !collectionId) return;
    let cancelled = false;
    void findOpenPlannerSession(user.id, collectionId).then((s) => {
      if (!cancelled && s) setBatch(s);
    });
    return () => {
      cancelled = true;
    };
  }, [user, collectionId]);

  const { data: rawItems = [] } = useImportItems(batch?.id);
  const items: ImportItem[] = useMemo(
    () => rawItems.filter((i) => i.status === 'AWAITING_GROUPING'),
    [rawItems],
  );
  const itemsByRecipe = useMemo(() => {
    const m = new Map<string, ImportItem[]>();
    for (const i of items) {
      if (!i.assignedRecipeId) continue;
      const list = m.get(i.assignedRecipeId) ?? [];
      list.push(i);
      m.set(i.assignedRecipeId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.pageIndex - b.pageIndex);
    return m;
  }, [items]);

  // ---------- pick ----------
  if (phase === 'pick') {
    const eligible = collections.filter(
      (c) =>
        c.sourceType === 'PUBLISHED_BOOK' &&
        c.recipes.some(
          (r) =>
            r.starred === true &&
            r.ingredients.length === 0 &&
            r.instructions.length === 0,
        ),
    );
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Speed Importer</h1>
          <p className="mt-1 max-w-2xl text-sm text-stone-600 dark:text-stone-400">
            Star ToC placeholder recipes on a cookbook page, then come back here
            and the planner will walk you through scanning them in page order
            — one tap per shot, automatic page grouping, automatic linkage.
          </p>
        </div>
        {eligible.length === 0 ? (
          <div className="rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900 p-4 text-sm text-stone-700 dark:text-stone-300">
            No cookbooks with starred placeholders yet. Open a cookbook in your
            library and tap the ☆ next to recipes you want to scan.
          </div>
        ) : (
          <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
            {eligible.map((c) => (
              <EligibleBookRow
                key={c.id}
                collection={c}
                ownerId={user?.id}
                onPick={() => {
                  setCollectionId(c.id);
                  setPhase('capture');
                }}
              />
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---------- capture / review / finalizing ----------
  if (!collection) {
    return <p className="text-stone-500 dark:text-stone-400">Loading cookbook…</p>;
  }

  // Starred placeholders, sorted by page number then title.
  const starredQueue: Recipe[] = collection.recipes
    .filter(
      (r) =>
        r.starred === true &&
        r.ingredients.length === 0 &&
        r.instructions.length === 0,
    )
    .sort((a, b) => {
      const ap = a.pageNumbers?.[0] ?? Number.MAX_SAFE_INTEGER;
      const bp = b.pageNumbers?.[0] ?? Number.MAX_SAFE_INTEGER;
      if (ap !== bp) return ap - bp;
      return a.title.localeCompare(b.title);
    });

  if (starredQueue.length === 0 && items.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Speed Importer</h1>
        <p className="text-stone-700 dark:text-stone-300">
          Nothing starred on <em>{collection.title}</em>. Tap the ☆ next to
          recipes on the cookbook page to queue them.
        </p>
        <Link
          to={`/collections/${collection.id}`}
          className="inline-flex rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          ← Back to cookbook
        </Link>
      </div>
    );
  }

  if (phase === 'finalizing') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Starting OCR…</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          Queueing each recipe as one OCR call. You can leave this page;
          progress shows up on the batch board.
        </p>
      </div>
    );
  }

  if (phase === 'review') {
    return (
      <ReviewPanel
        collection={collection}
        queue={starredQueue}
        itemsByRecipe={itemsByRecipe}
        ownerId={user!.id}
        onBack={() => setPhase('capture')}
        onConfirm={async () => {
          if (!batch) {
            // No items uploaded at all — bounce back to capture.
            setPhase('capture');
            return;
          }
          setPhase('finalizing');
          try {
            const { recipeCount } = await finalizePlannerSession(user!.id, batch.id);
            await syncNow();
            qc.invalidateQueries({ queryKey: ['import-items', batch.id] });
            qc.invalidateQueries({ queryKey: ['import-batch', batch.id] });
            if (recipeCount === 0) {
              setPhase('capture');
              return;
            }
            navigate(`/import/${batch.id}`);
          } catch {
            setPhase('review');
          }
        }}
      />
    );
  }

  return (
    <CapturePanel
      collection={collection}
      queue={starredQueue}
      itemsByRecipe={itemsByRecipe}
      ownerId={user!.id}
      registeredProviders={ocrKeys.map((k) => k.provider)}
      batch={batch}
      batchRef={batchRef}
      onBatchCreated={(b) => setBatch(b)}
      onReview={() => setPhase('review')}
    />
  );
}

function EligibleBookRow({
  collection,
  ownerId,
  onPick,
}: {
  collection: RecipeCollection;
  ownerId: string | undefined;
  onPick: () => void;
}) {
  const [hasOpen, setHasOpen] = useState(false);
  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    void findOpenPlannerSession(ownerId, collection.id).then((s) => {
      if (!cancelled) setHasOpen(!!s);
    });
    return () => {
      cancelled = true;
    };
  }, [ownerId, collection.id]);
  const starred = collection.recipes.filter(
    (r) =>
      r.starred === true &&
      r.ingredients.length === 0 &&
      r.instructions.length === 0,
  ).length;
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-stone-50 dark:hover:bg-stone-900"
      >
        <span>
          <span className="block font-medium">{collection.title}</span>
          <span className="text-xs text-stone-500 dark:text-stone-400">
            {starred} starred{hasOpen && ' · resume'}
          </span>
        </span>
        <span aria-hidden className="text-stone-400">
          →
        </span>
      </button>
    </li>
  );
}

function CapturePanel({
  collection,
  queue,
  itemsByRecipe,
  ownerId,
  registeredProviders,
  batch,
  batchRef,
  onBatchCreated,
  onReview,
}: {
  collection: RecipeCollection;
  queue: Recipe[];
  itemsByRecipe: Map<string, ImportItem[]>;
  ownerId: string;
  registeredProviders: readonly string[];
  batch: ImportBatch | undefined;
  batchRef: React.MutableRefObject<ImportBatch | undefined>;
  onBatchCreated: (b: ImportBatch) => void;
  onReview: () => void;
}) {
  // `cursor` is the user's place in the starred queue. Skipping a
  // recipe (or advancing after capturing) moves it forward. Wraps
  // back to the first recipe with no shots once the user reaches the
  // end, so they can revisit anything they skipped without leaving
  // the panel.
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const qc = useQueryClient();

  // Walk forward until we find a recipe the cursor hasn't passed.
  // `currentRecipe` falls back to the last item in the queue so the
  // panel doesn't crash when the queue length changes under us.
  const currentRecipe = queue[Math.min(cursor, queue.length - 1)];
  const currentShots = currentRecipe
    ? itemsByRecipe.get(currentRecipe.id) ?? []
    : [];

  const totalShotsAcross = useMemo(
    () => Array.from(itemsByRecipe.values()).reduce((acc, list) => acc + list.length, 0),
    [itemsByRecipe],
  );
  const recipesWithAnyShot = useMemo(
    () => queue.filter((r) => (itemsByRecipe.get(r.id)?.length ?? 0) > 0).length,
    [queue, itemsByRecipe],
  );

  async function takeShot() {
    if (!currentRecipe || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      const file = await plannerShutter();
      if (!file) {
        setBusy(false);
        return;
      }
      // Lazy batch create on first shot. Use the ref so a quick re-tap
      // sees the freshly-created batch without waiting for React state.
      let activeBatch = batchRef.current;
      if (!activeBatch) {
        activeBatch = await ensurePlannerBatch(
          ownerId,
          collection.id,
          collection.title,
          registeredProviders,
        );
        batchRef.current = activeBatch;
        onBatchCreated(activeBatch);
      }
      await addPlannedShot(
        activeBatch,
        {
          recipeId: currentRecipe.id,
          collectionId: collection.id,
          pageNumber: currentRecipe.pageNumbers?.[0] ?? null,
        },
        file,
      );
      await plannerHapticTick();
      // Re-query so the thumb appears immediately.
      qc.invalidateQueries({ queryKey: ['import-items', activeBatch.id] });
    } catch (e) {
      setError((e as Error).message ?? 'Capture failed');
    } finally {
      setBusy(false);
    }
  }

  function nextRecipe() {
    setCursor((c) => Math.min(c + 1, queue.length - 1));
  }
  function prevRecipe() {
    setCursor((c) => Math.max(c - 1, 0));
  }
  function skipRecipe() {
    // Skip is the same forward motion; we keep skipped recipes in
    // the queue (still starred) so the user can come back to them.
    nextRecipe();
  }

  async function removeShot(itemId: string) {
    try {
      await discardPlannedShot(ownerId, itemId);
      qc.invalidateQueries({ queryKey: ['import-items', batch?.id] });
    } catch (e) {
      setError((e as Error).message ?? 'Remove failed');
    }
  }

  if (!currentRecipe) {
    // Queue empty but session not finalized — just show review.
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">All starred recipes scanned</h1>
        <button
          type="button"
          onClick={onReview}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          Review &amp; start OCR
        </button>
      </div>
    );
  }

  const pageNum = currentRecipe.pageNumbers?.[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
            {collection.title} · Speed Importer
          </div>
          <h1 className="text-2xl font-semibold">Scan recipes</h1>
        </div>
        <Link
          to={`/collections/${collection.id}`}
          className="text-sm text-stone-500 dark:text-stone-400 hover:underline"
        >
          Done for now
        </Link>
      </div>

      <div className="rounded-lg border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-indigo-900 dark:text-indigo-200">
          <span className="rounded-full bg-indigo-200 dark:bg-indigo-900 px-2 py-0.5 font-medium">
            {cursor + 1} / {queue.length}
          </span>
          {pageNum != null && (
            <span>
              Open to{' '}
              <strong className="text-lg font-semibold">page {pageNum}</strong>
            </span>
          )}
        </div>
        <div className="mt-2 text-2xl font-semibold leading-tight text-indigo-950 dark:text-indigo-100">
          {currentRecipe.title}
        </div>
        <div className="mt-2 text-xs text-indigo-700 dark:text-indigo-300">
          {currentShots.length === 0
            ? 'Take one photo per page. If this recipe spans multiple pages, tap shutter again for each.'
            : `${currentShots.length} photo${currentShots.length === 1 ? '' : 's'} captured for this recipe.`}
        </div>
      </div>

      <button
        type="button"
        onClick={takeShot}
        disabled={busy}
        aria-label="Take photo"
        className="block w-full rounded-2xl bg-stone-900 dark:bg-stone-100 px-6 py-6 text-lg font-semibold text-white dark:text-stone-900 shadow-lg hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-60 active:scale-[0.99] transition"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        {busy ? 'Uploading…' : currentShots.length === 0 ? '📷  Take photo' : '📷  Take another'}
      </button>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {currentShots.length > 0 && (
        <div className="overflow-x-auto">
          <ol className="flex gap-2 pb-1">
            {currentShots.map((shot, i) => (
              <li key={shot.id} className="relative shrink-0">
                <div className="h-24 w-20 overflow-hidden rounded border border-stone-200 dark:border-stone-700">
                  <ImportThumb
                    path={shot.thumbPath ?? shot.storagePath}
                    className="h-full w-full object-cover"
                    alt={`Shot ${i + 1}`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void removeShot(shot.id)}
                  className="absolute right-1 top-1 rounded-full bg-stone-900/80 px-1.5 text-xs leading-tight text-white shadow"
                  aria-label={`Remove shot ${i + 1}`}
                >
                  ×
                </button>
                <span className="absolute bottom-0 left-0 rounded-tr bg-stone-900/80 px-1 text-[10px] text-white">
                  p{i + 1}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 text-sm">
        <button
          type="button"
          onClick={prevRecipe}
          disabled={cursor === 0}
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-2 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40"
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={skipRecipe}
          disabled={cursor >= queue.length - 1}
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-2 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={nextRecipe}
          disabled={cursor >= queue.length - 1}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-2 font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-40"
        >
          Next →
        </button>
      </div>

      <button
        type="button"
        onClick={onReview}
        disabled={totalShotsAcross === 0}
        className="block w-full rounded-md border border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 text-sm font-medium text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 disabled:opacity-50"
      >
        Done — review &amp; start OCR
        {recipesWithAnyShot > 0 && (
          <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-300">
            ({recipesWithAnyShot} recipe{recipesWithAnyShot === 1 ? '' : 's'} ·{' '}
            {totalShotsAcross} photo{totalShotsAcross === 1 ? '' : 's'})
          </span>
        )}
      </button>
    </div>
  );
}

function ReviewPanel({
  collection,
  queue,
  itemsByRecipe,
  ownerId,
  onBack,
  onConfirm,
}: {
  collection: RecipeCollection;
  queue: Recipe[];
  itemsByRecipe: Map<string, ImportItem[]>;
  ownerId: string;
  onBack: () => void;
  onConfirm: () => Promise<void>;
}) {
  const qc = useQueryClient();
  const filled = queue.filter((r) => (itemsByRecipe.get(r.id)?.length ?? 0) > 0);

  async function removeShot(batchId: string, itemId: string) {
    await discardPlannedShot(ownerId, itemId);
    qc.invalidateQueries({ queryKey: ['import-items', batchId] });
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
          {collection.title} · review
        </div>
        <h1 className="text-2xl font-semibold">Review captures</h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          {filled.length} recipe{filled.length === 1 ? '' : 's'} ready. Each
          recipe goes to OCR as one call so multi-page recipes stay together.
        </p>
      </div>

      <ul className="space-y-3">
        {filled.map((r) => {
          const shots = itemsByRecipe.get(r.id) ?? [];
          const pageNum = r.pageNumbers?.[0];
          return (
            <li
              key={r.id}
              className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-base font-medium">{r.title}</div>
                  {pageNum != null && (
                    <div className="text-xs text-stone-500 dark:text-stone-400">
                      p. {pageNum}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                  {shots.length} photo{shots.length === 1 ? '' : 's'}
                </div>
              </div>
              <ol className="mt-2 flex gap-2 overflow-x-auto pb-1">
                {shots.map((shot, i) => (
                  <li key={shot.id} className="relative shrink-0">
                    <div className="h-24 w-20 overflow-hidden rounded border border-stone-200 dark:border-stone-700">
                      <ImportThumb
                        path={shot.thumbPath ?? shot.storagePath}
                        className="h-full w-full object-cover"
                        alt={`${r.title} photo ${i + 1}`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void removeShot(shot.batchId, shot.id)}
                      className="absolute right-1 top-1 rounded-full bg-stone-900/80 px-1.5 text-xs leading-tight text-white shadow"
                      aria-label={`Remove photo ${i + 1}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={filled.length === 0}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
        >
          Start OCR on {filled.length} recipe{filled.length === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-4 py-2 text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
        >
          Back to capture
        </button>
      </div>
    </div>
  );
}
