import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createCookbook,
  exact,
  formatQuantity,
  isMeasured,
  measured,
  parseIngredientLine,
  Units,
  vague,
  instruction,
  type Ingredient,
  type Instruction,
  type ParsedRecipeDraft,
  type Quantity,
  type RecipeCollection,
} from '@cookyourbooks/domain';
import {
  useCollection,
  useCollectionPickerOptions,
  useSaveCollection,
  useSaveRecipe,
} from '../data/queries.js';
import {
  useImportBatch,
  useImportItem,
  useImportItems,
  useImportItemAttempts,
  useImportTocEntries,
  useUpdateImportItem,
} from '../import/queries.js';
import { kickOcr, resetImportItem, setImportItemKind, setImportItemToc } from '../import/api.js';
import { buildRecipeFromDraft } from '../import/promoteDraft.js';
import { CookbookCombobox } from '../import/CookbookCombobox.js';
import { TocReviewPanel } from '../import/TocReviewPanel.js';
import { NotesReviewPanel } from '../import/NotesReviewPanel.js';
import { BakeoffItemReview } from '../import/BakeoffItemReview.js';
import type { CollectionPickerOption } from '../local/repositories.js';
import { OcrStatusBanner } from '../import/OcrStatusBanner.js';
import { canReOcr } from '../import/ocrStatus.js';
import { useSync } from '../local/SyncProvider.js';
import { getSignedImportUrl, ImportThumb } from '../import/ImportThumb.js';
import { scoreTocMatch, suggestTocMatches } from '../import/tocMatch.js';
import { PinchPanImage } from '../components/PinchPanImage.js';
import { deleteOcrStorage } from '../import/deleteStorage.js';
import { LoadingState } from '../components/LoadingState.js';

export function ImportItemPage() {
  const { batchId, itemId } = useParams();
  const { data: batch, isLoading: batchLoading } = useImportBatch(batchId);
  const { data: item, isLoading: itemLoading } = useImportItem(itemId);
  const { data: batchItems = [] } = useImportItems(batchId);
  const { data: attempts = [] } = useImportItemAttempts(itemId);
  const { data: tocEntries = [] } = useImportTocEntries(batchId);
  const { data: pickerOptions = [], isLoading: pickerLoading } = useCollectionPickerOptions();
  // Eager target-cookbook fetch so the save flow can fuzzy-match the
  // draft title against existing recipes (placeholder ToC entries)
  // and update that recipe in place rather than always creating new.
  const resolvedTargetId =
    item?.assignedCollectionId ?? batch?.targetCollectionId ?? '';
  const { data: targetCollection } = useCollection(resolvedTargetId);
  const updateItem = useUpdateImportItem();
  const { syncNow, status: syncStatus, localReady, hydrated } = useSync();
  const navigate = useNavigate();
  const [toast, setToast] = useState<string | undefined>();
  const [fullscreen, setFullscreen] = useState(false);

  const [activeDraft, setActiveDraft] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imgUrl, setImgUrl] = useState<string | undefined>();
  const [assignedCollectionId, setAssignedCollectionId] = useState<string>('');
  const [pageNumberStr, setPageNumberStr] = useState('');
  const [showTocSuggestions, setShowTocSuggestions] = useState(false);
  const [draftPatches, setDraftPatches] = useState<Record<number, ParsedRecipeDraft>>({});
  const [actionError, setActionError] = useState<string | undefined>();
  const [togglingToc, setTogglingToc] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ active: boolean; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const pinch = useRef<{
    startDist: number;
    startMidX: number;
    startMidY: number;
    startZoom: number;
    origX: number;
    origY: number;
  } | null>(null);

  useEffect(() => {
    if (!item) return;
    setAssignedCollectionId(
      item.assignedCollectionId ?? batch?.targetCollectionId ?? '',
    );
    setPageNumberStr(
      item.assignedPageNumber != null ? String(item.assignedPageNumber) : '',
    );
  }, [item, batch?.targetCollectionId]);

  useEffect(() => {
    if (!item?.storagePath) return;
    let cancelled = false;
    void getSignedImportUrl(item.storagePath)
      .then((u) => {
        if (!cancelled) setImgUrl(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item?.storagePath]);

  const saveRecipe = useSaveRecipe(assignedCollectionId || batch?.targetCollectionId || '');

  const drafts = useMemo<ParsedRecipeDraft[]>(() => item?.parsedDrafts ?? [], [item]);
  const currentDraft: ParsedRecipeDraft | undefined =
    draftPatches[activeDraft] ?? drafts[activeDraft];

  // Prev / next neighbour in the batch by page_index — used by the
  // keyboard shortcuts and the nav banner. Intentionally NOT filtered
  // by status: the user wants strict sequential browsing, so ← from
  // page 5 lands on page 4 even if page 4 is already REVIEWED. The
  // save / discard handlers use findReviewable (a separate helper
  // that skips done items) for "what's the next thing that needs
  // attention" auto-advance.
  const prevItem = useMemo(
    () => (item ? findAdjacent(batchItems, item.id, 'prev') : undefined),
    [batchItems, item],
  );
  const nextItem = useMemo(
    () => (item ? findAdjacent(batchItems, item.id, 'next') : undefined),
    [batchItems, item],
  );
  const pageNumberInBatch = useMemo(() => {
    if (!item) return undefined;
    const sorted = [...batchItems].sort((a, b) => a.pageIndex - b.pageIndex);
    const idx = sorted.findIndex((i) => i.id === item.id);
    return idx >= 0
      ? { current: idx + 1, total: sorted.length }
      : undefined;
  }, [batchItems, item]);

  // Keyboard shortcuts. Skip while a text input or contenteditable is
  // focused so the editor's own typing isn't hijacked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowRight':
        case 'j':
          if (batch && nextItem) {
            e.preventDefault();
            navigate(`/import/${batch.id}/items/${nextItem.id}`);
          }
          break;
        case 'ArrowLeft':
        case 'k':
          if (batch && prevItem) {
            e.preventDefault();
            navigate(`/import/${batch.id}/items/${prevItem.id}`);
          }
          break;
        case 'f':
          e.preventDefault();
          setFullscreen((cur) => !cur);
          break;
        case 'Escape':
          if (fullscreen) {
            e.preventDefault();
            setFullscreen(false);
          }
          break;
        case '?':
          e.preventDefault();
          showToast(
            setToast,
            'Shortcuts: ← / k prev · → / j next · f fullscreen · esc exit',
          );
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [batch, nextItem, prevItem, fullscreen, navigate]);

  const tocSuggestions = useMemo(
    () =>
      currentDraft?.title
        ? suggestTocMatches(currentDraft.title, tocEntries, { limit: 5 })
        : [],
    [currentDraft?.title, tocEntries],
  );

  // When the Speed Importer planner bound this scan to a specific
  // placeholder up front (`item.assignedRecipeId`), trust that
  // binding — the user already told us where this scan belongs, so
  // skip the fuzzy match entirely.
  const plannedRecipe = useMemo(() => {
    if (!item?.assignedRecipeId || !targetCollection) return undefined;
    const r = (targetCollection.recipes ?? []).find((rr) => rr.id === item.assignedRecipeId);
    return r ? { id: r.id, title: r.title } : undefined;
  }, [item?.assignedRecipeId, targetCollection]);

  // Fallback: look for an existing recipe in the target cookbook whose
  // title matches the draft. Used to merge into placeholder ToC entries
  // rather than create duplicates. Threshold is intentionally tight
  // (0.85) — we want OCR-cleanup matches like "Garam Masala" vs
  // "garam masala" to fold together, but distinct recipes that happen
  // to share a noun ("Crispy Cookies" vs "Chewy Cookies", ~0.77) must
  // stay separate. Skipped when the planner has already bound this scan.
  const matchedExisting = useMemo(() => {
    if (plannedRecipe) return undefined;
    if (!targetCollection || !currentDraft?.title) return undefined;
    let best: { id: string; title: string; score: number } | undefined;
    for (const r of targetCollection.recipes ?? []) {
      const score = scoreTocMatch(currentDraft.title, r.title);
      if (score >= 0.85 && (!best || score > best.score)) {
        best = { id: r.id, title: r.title, score };
      }
    }
    return best;
  }, [plannedRecipe, targetCollection, currentDraft?.title]);

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const next = Math.max(0.5, Math.min(4, zoom + (e.deltaY < 0 ? 0.15 : -0.15)));
    setZoom(next);
  }

  function onMouseDown(e: React.MouseEvent) {
    drag.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: pan.x,
      origY: pan.y,
    };
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!drag.current?.active) return;
    setPan({
      x: drag.current.origX + (e.clientX - drag.current.startX),
      y: drag.current.origY + (e.clientY - drag.current.startY),
    });
  }
  function onMouseUp() {
    if (drag.current) drag.current.active = false;
  }

  // Touch handlers — one finger pans (mirrors mouse drag), two fingers pinch
  // zoom. iOS WKWebView's default page-level pinch is suppressed via
  // `touchAction: 'none'` on the viewer div below, so the gesture stays
  // scoped to this image instead of zooming the surrounding page.
  function onTouchStart(e: React.TouchEvent) {
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    if (e.touches.length === 1 && t0) {
      drag.current = {
        active: true,
        startX: t0.clientX,
        startY: t0.clientY,
        origX: pan.x,
        origY: pan.y,
      };
      pinch.current = null;
    } else if (e.touches.length === 2 && t0 && t1) {
      drag.current = null;
      pinch.current = {
        startDist: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
        startMidX: (t0.clientX + t1.clientX) / 2,
        startMidY: (t0.clientY + t1.clientY) / 2,
        startZoom: zoom,
        origX: pan.x,
        origY: pan.y,
      };
    }
  }
  function onTouchMove(e: React.TouchEvent) {
    e.preventDefault();
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    if (e.touches.length === 1 && t0 && drag.current?.active) {
      setPan({
        x: drag.current.origX + (t0.clientX - drag.current.startX),
        y: drag.current.origY + (t0.clientY - drag.current.startY),
      });
    } else if (e.touches.length === 2 && t0 && t1 && pinch.current) {
      const newDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const ratio = newDist / pinch.current.startDist;
      const mx = (t0.clientX + t1.clientX) / 2;
      const my = (t0.clientY + t1.clientY) / 2;
      setZoom(Math.max(0.5, Math.min(4, pinch.current.startZoom * ratio)));
      setPan({
        x: pinch.current.origX + (mx - pinch.current.startMidX),
        y: pinch.current.origY + (my - pinch.current.startMidY),
      });
    }
  }
  function onTouchEnd(e: React.TouchEvent) {
    const remaining = e.touches[0];
    if (e.touches.length === 0) {
      drag.current = null;
      pinch.current = null;
    } else if (e.touches.length === 1 && remaining && pinch.current) {
      // Pinch released to one-finger; seed a pan from current position so
      // the image doesn't jump.
      pinch.current = null;
      drag.current = {
        active: true,
        startX: remaining.clientX,
        startY: remaining.clientY,
        origX: pan.x,
        origY: pan.y,
      };
    }
  }

  if (!localReady || batchLoading || itemLoading) {
    return <LoadingState surface="import-item" />;
  }
  if ((!batch || !item) && !hydrated) {
    return <p className="text-stone-500 dark:text-stone-400">Initializing local cache…</p>;
  }
  if (!batch || !item) {
    return (
      <div className="space-y-3">
        <p className="text-stone-700 dark:text-stone-300">
          {!batch ? 'Batch' : 'Item'} not found locally.
        </p>
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

  const targetCollectionId =
    assignedCollectionId || batch.targetCollectionId || '';

  // ToC entries belonging to *this* page (a batch may hold several ToC
  // scans). Feeds the review/approve panel below.
  const itemTocEntries = tocEntries.filter((e) => e.itemId === item.id);

  const reOcrAllowed = canReOcr(item.status);

  // Called by TocReviewPanel once it has minted the approved placeholder
  // recipes. Persist the chosen cookbook, close the item out as REVIEWED,
  // and advance to the next thing that still needs attention.
  async function onTocApproved(created: number) {
    if (!item || !batch) return;
    setActionError(undefined);
    try {
      await updateItem.mutateAsync({
        id: item.id,
        patch: {
          assignedCollectionId: targetCollectionId || null,
          status: 'REVIEWED',
        },
      });
      await syncNow();
      showToast(
        setToast,
        created === 0
          ? 'Entries already in the cookbook — nothing new to add.'
          : `Created ${created} placeholder recipe${created === 1 ? '' : 's'}.`,
      );
      const next = findReviewable(batchItems, item.id, 'next');
      navigate(next ? `/import/${batch.id}/items/${next.id}` : `/import/${batch.id}`);
    } catch (e) {
      setActionError(`Couldn't finish the table-of-contents review: ${(e as Error).message}`);
    }
  }

  // Flag (or un-flag) this page as a Table of Contents. Flipping the
  // flag always re-runs OCR: a page first read as a recipe has to be
  // re-read with the ToC prompt to yield entries (and vice versa). The
  // client can't drive that PENDING transition through the outbox — the
  // push scrub only honours REVIEWED / DISCARDED — so it goes through a
  // server RPC that resets the row, clears the stale drafts + any prior
  // ToC entries, and sets is_toc atomically. We then kick the worker.
  async function toggleIsToc() {
    if (!item || !batch || togglingToc) return;
    setActionError(undefined);
    setTogglingToc(true);
    const next = !item.isToc;
    try {
      await setImportItemToc(item.id, next);
      await syncNow();
      try {
        await kickOcr(batch.id);
      } catch {
        // pg_cron / the next user kick will pick up the slack.
      }
      showToast(
        setToast,
        next
          ? 'Marked as Table of Contents — re-reading the page…'
          : 'Unmarked — re-reading the page as a recipe…',
      );
    } catch (e) {
      setActionError(`Couldn't re-OCR this page: ${(e as Error).message}`);
    } finally {
      setTogglingToc(false);
    }
  }

  // Marking a page as notes re-OCRs it with the notes prompt and auto-files the
  // prose as a collection note (server-side, same re-arm path as ToC). `kind`
  // is one value, so this and the ToC toggle are mutually exclusive.
  async function toggleNotes() {
    if (!item || !batch || togglingToc) return;
    setActionError(undefined);
    setTogglingToc(true);
    const next = item.kind !== 'NOTES';
    try {
      await setImportItemKind(item.id, next ? 'NOTES' : 'RECIPE');
      await syncNow();
      try {
        await kickOcr(batch.id);
      } catch {
        // pg_cron / the next user kick will pick up the slack.
      }
      showToast(
        setToast,
        next
          ? 'Marked as a notes page — re-reading the page…'
          : 'Unmarked — re-reading the page as a recipe…',
      );
    } catch (e) {
      setActionError(`Couldn't re-OCR this page: ${(e as Error).message}`);
    } finally {
      setTogglingToc(false);
    }
  }

  function patchDraft(patch: Partial<ParsedRecipeDraft>) {
    const base = draftPatches[activeDraft] ?? drafts[activeDraft];
    if (!base) return;
    setDraftPatches((cur) => ({ ...cur, [activeDraft]: { ...base, ...patch } }));
  }

  async function saveAsRecipe() {
    if (!currentDraft || !targetCollectionId || !item || !batch) return;
    setActionError(undefined);
    const pageNum = pageNumberStr ? Number(pageNumberStr) : undefined;
    const pageNumbers =
      pageNum && Number.isFinite(pageNum)
        ? [pageNum]
        : currentDraft.pageNumbers
          ? [...currentDraft.pageNumbers]
          : undefined;
    const remainingAfter = drafts.length - 1; // local count of drafts still left on this item
    const nextItem = remainingAfter === 0 ? findReviewable(batchItems, item.id, 'next') : undefined;
    // Toast immediately so the user has feedback before the network
    // round-trip finishes. The actual save still runs in the
    // background; if it fails we surface that via actionError below.
    if (remainingAfter > 0) {
      showToast(setToast, 'Saving recipe…');
    } else if (nextItem) {
      showToast(setToast, 'Saving recipe and continuing to next…');
    } else {
      showToast(setToast, 'Saving recipe — batch complete!');
    }
    // Planner pre-binding takes precedence over fuzzy match (both feed
    // recipeId/overwriteTitle); the target cookbook's title wins for
    // bookTitle. See buildRecipeFromDraft.
    const recipe = buildRecipeFromDraft(currentDraft, {
      collectionTitle: targetCollection?.title,
      recipeId: plannedRecipe?.id ?? matchedExisting?.id,
      overwriteTitle: plannedRecipe?.title ?? matchedExisting?.title,
      pageNumbers,
    });
    try {
      await saveRecipe.mutateAsync(recipe);
      const nextDrafts = drafts.filter((_, i) => i !== activeDraft);
      const createdIds = [...(item.createdRecipeIds ?? []), recipe.id];
      const remaining = nextDrafts.length;
      await updateItem.mutateAsync({
        id: item.id,
        patch: {
          parsedDrafts: nextDrafts,
          createdRecipeIds: createdIds,
          assignedCollectionId: targetCollectionId,
          assignedPageNumber: pageNum && Number.isFinite(pageNum) ? pageNum : null,
          status: remaining === 0 ? 'REVIEWED' : item.status,
        },
      });
      await syncNow();
      // Stay in the import workflow. If there are more drafts on this
      // image, advance to the next one. If this was the last draft on
      // this item, hop to the next reviewable item in the batch so the
      // user can keep moving through their stack. Fall back to the
      // batch board if nothing else needs attention.
      if (remaining > 0) {
        setActiveDraft(0);
        setDraftPatches({});
        return;
      }
      if (nextItem) {
        navigate(`/import/${batch.id}/items/${nextItem.id}`);
      } else {
        navigate(`/import/${batch.id}`);
      }
    } catch (e) {
      setActionError(`Save failed: ${(e as Error).message}`);
    }
  }

  async function discardThisDraft() {
    if (!item || !currentDraft || !batch) return;
    setActionError(undefined);
    const nextDrafts = drafts.filter((_, i) => i !== activeDraft);
    try {
      await updateItem.mutateAsync({
        id: item.id,
        patch: {
          parsedDrafts: nextDrafts,
          status: nextDrafts.length === 0 ? 'REVIEWED' : item.status,
        },
      });
      await syncNow();
      if (nextDrafts.length > 0) {
        setActiveDraft(0);
        setDraftPatches({});
        return;
      }
      const nextItem = findReviewable(batchItems, item.id, 'next');
      if (nextItem) {
        navigate(`/import/${batch.id}/items/${nextItem.id}`);
      } else {
        navigate(`/import/${batch.id}`);
      }
    } catch (e) {
      setActionError(`Discard failed: ${(e as Error).message}`);
    }
  }

  async function reOcrWithFallback() {
    if (!item || !batch) return;
    setActionError(undefined);
    try {
      // Server-side reset: clears status / claim / attempts / drafts
      // in one statement. Local UI updates through the realtime
      // subscription. Doing it via the client outbox doesn't work
      // because the push handler refuses any status that isn't
      // REVIEWED or DISCARDED (server-owned), so an in-place flip
      // here never reached the worker.
      await resetImportItem(item.id);
      await syncNow();
      try {
        await kickOcr(batch.id);
      } catch {
        // pg_cron / next user kick will retry.
      }
      showToast(setToast, 'Reset for re-OCR — worker will pick it up shortly');
    } catch (e) {
      setActionError(`Re-OCR failed: ${(e as Error).message}`);
    }
  }

  async function discardItem() {
    if (!item) return;
    if (!confirm('Discard this entire item? It will be hidden from the batch.')) return;
    await updateItem.mutateAsync({ id: item.id, patch: { status: 'DISCARDED' } });
    navigate(`/import/${batch!.id}`);
  }

  return (
    <div className="space-y-4 pb-12">
      {toast && <ToastBanner message={toast} />}
      {fullscreen && imgUrl && (
        <FullscreenImage src={imgUrl} alt={`Page ${item.pageIndex + 1}`} onClose={() => setFullscreen(false)} />
      )}
      <NavBanner
        batchName={batch.name}
        batchId={batch.id}
        prevId={prevItem?.id}
        nextId={nextItem?.id}
        position={pageNumberInBatch}
        currentPageIndex={item.pageIndex + 1}
        save={
          !item.isToc &&
          !(batch.batchKind === 'BAKEOFF' &&
            (item.status === 'BAKEOFF_READY' || item.status === 'BAKEOFF_PENDING'))
            ? {
                onSave: () => void saveAsRecipe(),
                disabled: !currentDraft || !targetCollectionId || saveRecipe.isPending,
                saving: saveRecipe.isPending,
                label: plannedRecipe
                  ? `Fill "${plannedRecipe.title}"`
                  : matchedExisting
                    ? `Update "${matchedExisting.title}"`
                    : 'Save as recipe',
              }
            : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div
            ref={viewerRef}
            onWheel={onWheel}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            className="relative aspect-[3/4] cursor-grab overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-100 dark:bg-stone-800"
            style={{ touchAction: 'none' }}
          >
            {imgUrl ? (
              <img
                src={imgUrl}
                alt={`Page ${item.pageIndex + 1}`}
                className="absolute inset-0 h-full w-full select-none object-contain"
                draggable={false}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: 'center',
                }}
              />
            ) : (
              <ImportThumb path={item.storagePath} className="h-full w-full object-contain" />
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-400">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
              className="rounded border border-stone-300 dark:border-stone-600 px-2 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
              className="rounded border border-stone-300 dark:border-stone-600 px-2 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="ml-2 rounded border border-stone-300 dark:border-stone-600 px-2 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Fit
            </button>
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              className="rounded border border-stone-300 dark:border-stone-600 px-2 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
              title="Fullscreen (f)"
            >
              ⛶ Fullscreen
            </button>
            <span className="ml-auto text-stone-500 dark:text-stone-400">Ctrl/⌘+scroll to zoom · drag to pan · f for fullscreen · ← / → to navigate</span>
          </div>

          {item.extraStoragePaths.length > 0 && (
            <MergedPagesStrip
              primaryPath={item.storagePath}
              extras={item.extraStoragePaths}
              activeUrl={imgUrl}
              onPick={(p) => {
                void getSignedImportUrl(p).then((u) => setImgUrl(u));
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            />
          )}

          <details className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              Attempt history ({attempts.length})
            </summary>
            <ul className="divide-y divide-stone-200 dark:divide-stone-700 px-3 pb-2 text-xs text-stone-700 dark:text-stone-300">
              {attempts.length === 0 && <li className="py-2 text-stone-500 dark:text-stone-400">No attempts yet.</li>}
              {attempts.map((a) => (
                <li key={a.id} className="space-y-0.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">#{a.attemptNo}</span>
                    <span>{a.provider}</span>
                    <code className="rounded bg-stone-100 dark:bg-stone-800 px-1">{a.model}</code>
                    <span
                      className={
                        a.errorKind && a.errorKind !== 'OK'
                          ? 'text-red-700'
                          : 'text-emerald-700'
                      }
                    >
                      {a.errorKind ?? 'OK'}
                    </span>
                    <span className="ml-auto text-stone-500 dark:text-stone-400">
                      {a.latencyMs}ms · ${(a.costUsdMicros / 1_000_000).toFixed(4)}
                    </span>
                  </div>
                  {a.errorMessage && (
                    <div className="text-stone-600 dark:text-stone-400">{a.errorMessage}</div>
                  )}
                  {a.rawResponsePath && (
                    <ViewRawLink path={a.rawResponsePath} />
                  )}
                </li>
              ))}
            </ul>
          </details>
        </div>

        <div className="space-y-3">
          <OcrStatusBanner item={item} batchItems={batchItems} />

          <div className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3 text-sm">
            <label className={`flex items-center gap-2 ${togglingToc ? 'cursor-progress opacity-70' : ''}`}>
              <input
                type="checkbox"
                checked={item.isToc}
                disabled={togglingToc}
                onChange={() => void toggleIsToc()}
              />
              <span>This is a Table of Contents page</span>
              {togglingToc && (
                <Spinner className="text-stone-400" label="Re-reading page…" />
              )}
            </label>
            <p className="mt-1 pl-6 text-xs text-stone-500 dark:text-stone-400">
              Toggling re-runs OCR on this page with the matching prompt —
              the table-of-contents reader or the recipe reader.
            </p>
          </div>

          <div className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3 text-sm">
            <label className={`flex items-center gap-2 ${togglingToc ? 'cursor-progress opacity-70' : ''}`}>
              <input
                type="checkbox"
                checked={item.kind === 'NOTES'}
                disabled={togglingToc}
                onChange={() => void toggleNotes()}
              />
              <span>This is an intro / notes page</span>
            </label>
            <p className="mt-1 pl-6 text-xs text-stone-500 dark:text-stone-400">
              Prose pages (forewords, chapter intros) are OCR'd as text and filed under the
              cookbook's Notes instead of as a recipe.
            </p>
          </div>

          {/* Target cookbook — both the recipe-save path and the ToC
              placeholder-creation path need somewhere to put their
              output, so the picker lives outside the isToc gate. */}
          <Field label="Cookbook">
            <CookbookField
              options={pickerOptions}
              value={assignedCollectionId}
              onChange={setAssignedCollectionId}
              loading={pickerLoading}
              matchedExistingTitle={item.kind === 'RECIPE' ? matchedExisting?.title : undefined}
            />
          </Field>

          {item.kind === 'TOC' ? (
            <>
              <TocReviewPanel
                entries={itemTocEntries}
                targetCollectionId={targetCollectionId}
                itemStatus={item.status}
                onApproved={onTocApproved}
              />
              {actionError && (
                <div className="rounded border border-red-200 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  {actionError}
                </div>
              )}
            </>
          ) : item.kind === 'NOTES' ? (
            <NotesReviewPanel
              itemId={item.id}
              defaultCollectionId={assignedCollectionId || targetCollectionId || null}
            />
          ) : (
            <>
              <Field label="Page number">
                <div className="relative">
                  <input
                    value={pageNumberStr}
                    onChange={(e) => setPageNumberStr(e.target.value)}
                    onFocus={() => setShowTocSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowTocSuggestions(false), 150)}
                    className="w-full rounded border border-stone-300 dark:border-stone-600 px-2 py-1.5 text-sm"
                    placeholder="e.g. 42"
                  />
                  {showTocSuggestions && tocSuggestions.length > 0 && (
                    <div className="absolute z-20 mt-1 w-full rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-md">
                      <ul className="max-h-48 overflow-auto py-1 text-xs">
                        {tocSuggestions.map((s) => (
                          <li key={s.entry.id}>
                            <button
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                if (s.entry.pageNumber != null) {
                                  setPageNumberStr(String(s.entry.pageNumber));
                                }
                                setShowTocSuggestions(false);
                              }}
                              className="block w-full px-3 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800"
                            >
                              <span className="font-medium">{s.entry.title}</span>
                              {s.entry.pageNumber != null && (
                                <span className="ml-2 text-stone-500 dark:text-stone-400">
                                  p. {s.entry.pageNumber}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </Field>

              {drafts.length > 1 && (
                <div
                  data-testid="draft-tabs"
                  role="tablist"
                  aria-label="Recipe drafts on this page"
                  className="flex gap-1 border-b border-stone-200 dark:border-stone-700"
                >
                  {drafts.map((d, i) => (
                    <button
                      key={i}
                      type="button"
                      role="tab"
                      aria-selected={activeDraft === i}
                      onClick={() => setActiveDraft(i)}
                      className={`-mb-px border-b-2 px-3 py-1.5 text-xs ${
                        activeDraft === i
                          ? 'border-stone-900 font-medium text-stone-900'
                          : 'border-transparent text-stone-600 hover:text-stone-900'
                      }`}
                    >
                      {d.title || `Recipe ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}

              {batch?.batchKind === 'BAKEOFF' &&
              (item.status === 'BAKEOFF_READY' || item.status === 'BAKEOFF_PENDING') ? (
                <BakeoffItemReview
                  batchId={batch.id}
                  itemId={item.id}
                  onWinnerSelected={() => void syncNow()}
                />
              ) : currentDraft ? (
                <DraftEditor draft={currentDraft} onPatch={patchDraft} />
              ) : item.status === 'OCR_FAILED' ? (
                <p className="text-sm text-red-700 dark:text-red-300">
                  OCR failed{item.lastError ? `: ${item.lastError}` : '.'} Use Re-OCR to try
                  again.
                </p>
              ) : (
                <p className="text-sm text-stone-600 dark:text-stone-400">No drafts yet — OCR results will appear here.</p>
              )}

              {plannedRecipe && targetCollection && (
                <div className="rounded-md border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 px-3 py-2 text-xs text-indigo-900 dark:text-indigo-200">
                  <strong>Planned:</strong> this scan is reserved for{' '}
                  <span className="font-medium">{plannedRecipe.title}</span> in{' '}
                  <em>{targetCollection.title}</em> (from the Speed Importer).
                  Save will fill that placeholder in place.
                </div>
              )}
              {!plannedRecipe && matchedExisting && targetCollection && (
                <div className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200">
                  <strong>Matches existing recipe:</strong>{' '}
                  <span className="font-medium">{matchedExisting.title}</span> in{' '}
                  <em>{targetCollection.title}</em>. Save will update that
                  entry in place (preserving its page order + any earlier
                  edits).
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void saveAsRecipe()}
                  disabled={!currentDraft || !targetCollectionId || saveRecipe.isPending}
                  className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
                >
                  {saveRecipe.isPending
                    ? 'Saving…'
                    : plannedRecipe
                      ? `Fill "${plannedRecipe.title}"`
                      : matchedExisting
                        ? `Update "${matchedExisting.title}"`
                        : 'Save as recipe'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraftPatches((cur) => {
                      const next = { ...cur };
                      delete next[activeDraft];
                      return next;
                    });
                    showToast(setToast, 'Restored to original OCR result');
                  }}
                  disabled={!draftPatches[activeDraft]}
                  title="Discard your edits to this draft and show the original OCR output"
                  className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
                >
                  Restore original
                </button>
                <button
                  type="button"
                  onClick={() => void discardThisDraft()}
                  disabled={!currentDraft}
                  className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
                >
                  Discard this draft
                </button>
                <button
                  type="button"
                  onClick={() => void reOcrWithFallback()}
                  disabled={!reOcrAllowed}
                  title={
                    reOcrAllowed
                      ? 'Clear drafts and queue this page for OCR again'
                      : 'Wait until OCR finishes or fails before re-running'
                  }
                  className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Re-OCR
                </button>
                <button
                  type="button"
                  onClick={() => void discardItem()}
                  className="rounded-md px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
                >
                  Discard entire item
                </button>
                <ItemDeleteStorageButton itemId={item.id} hasImage={!!item.storagePath} />
              </div>

              {(actionError || saveRecipe.isError) && (
                <div className="rounded border border-red-200 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  {actionError ?? (saveRecipe.error as Error).message}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Reuse the same parser the OCR JSON pipeline relies on. Wraps the
 * user's quantity-only input in a fake "<qty> x" sentence so we get
 * back a measured Ingredient, then pulls the Quantity off it. Empty
 * input clears the quantity (caller turns ingredient vague).
 */
function parseQuantityInput(input: string): Quantity | undefined | 'CLEAR' {
  const trimmed = input.trim();
  if (!trimmed) return 'CLEAR';
  const parsed = parseIngredientLine(`${trimmed} x`);
  return parsed && isMeasured(parsed) ? parsed.quantity : undefined;
}

/** Build the grouped unit catalog once. Used by QuantityEditor's
 *  unit dropdown so users see what we actually understand and don't
 *  guess at abbreviations. */
const UNIT_GROUPS: ReadonlyArray<{ label: string; units: readonly { name: string; abbr: string }[] }> = (() => {
  const groups = new Map<string, { label: string; units: { name: string; abbr: string }[] }>();
  function pushUnit(group: string, label: string, name: string, abbr: string) {
    if (!groups.has(group)) groups.set(group, { label, units: [] });
    groups.get(group)!.units.push({ name, abbr });
  }
  for (const u of Object.values(Units)) {
    const labelMap: Record<string, string> = {
      'VOLUME-METRIC': 'Volume · metric',
      'VOLUME-IMPERIAL': 'Volume · imperial',
      'WEIGHT-METRIC': 'Weight · metric',
      'WEIGHT-IMPERIAL': 'Weight · imperial',
      'COUNT-WHOLE': 'Count',
      'TASTE-SPECIAL': 'Taste / loose',
    };
    const key = `${u.dimension}-${u.system}`;
    pushUnit(key, labelMap[key] ?? key, u.name, u.abbreviations[0] ?? '');
  }
  return Array.from(groups.values());
})();

function QuantityEditor({
  quantity,
  onChange,
  onClear,
}: {
  quantity: Quantity | undefined;
  onChange: (next: Quantity) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  function open() {
    setAmount(quantity ? quantityAmountText(quantity) : '');
    setUnit(quantity?.unit ?? '');
    setEditing(true);
  }
  function close() {
    setEditing(false);
    setShowHelp(false);
  }
  function commit() {
    const a = amount.trim();
    if (!a) {
      onClear();
      close();
      return;
    }
    const parsed = parseQuantityInput(`${a} ${unit || 'piece'}`);
    if (parsed && parsed !== 'CLEAR') {
      // Honor the dropdown unit even when the user only typed a number
      // (parseQuantityInput needs SOME unit to land on EXACT; we fix
      // it up to the user's chosen unit here).
      onChange(unit ? { ...parsed, unit } as Quantity : parsed);
    } else if (!unit) {
      // No unit + unparsable amount: treat as count.
      const n = Number(a);
      if (Number.isFinite(n) && n > 0) onChange(exact(n, 'piece'));
    }
    close();
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        className="inline-block min-w-[3rem] rounded-md bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-xs font-medium text-stone-700 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-700"
        title="Click to edit quantity"
      >
        {quantity ? formatQuantity(quantity) : '(no qty)'}
      </button>
    );
  }

  return (
    <span className="relative inline-flex items-baseline gap-1 rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 p-1">
      <input
        autoFocus
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') close();
        }}
        placeholder="1 1/2"
        className="w-14 rounded border border-stone-200 dark:border-stone-700 px-1 py-0.5 text-xs"
      />
      <select
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        className="rounded border border-stone-200 dark:border-stone-700 px-1 py-0.5 text-xs"
      >
        <option value="">(no unit)</option>
        {UNIT_GROUPS.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.units.map((u) => (
              <option key={u.name} value={u.name}>
                {u.name}
                {u.abbr ? ` (${u.abbr})` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShowHelp((v) => !v)}
        aria-label="Help"
        className="rounded px-1 text-xs text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
      >
        ?
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={commit}
        className="rounded bg-stone-900 dark:bg-stone-100 px-1.5 py-0.5 text-xs text-white dark:text-stone-900"
      >
        ✓
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onClear();
          close();
        }}
        className="rounded px-1.5 py-0.5 text-xs text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
      >
        clear
      </button>
      {showHelp && (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-3 text-xs leading-relaxed text-stone-700 dark:text-stone-300 shadow-md"
        >
          <strong className="block text-stone-900 dark:text-stone-100">Units</strong>
          Pick a standard unit from the list. Amount accepts decimals
          (<code>1.5</code>), mixed numbers (<code>1 1/2</code>), or
          plain integers.
          <br />
          <br />
          <strong className="block text-stone-900 dark:text-stone-100">House units</strong>
          A "house unit" is your own measure — "a dollop", "one Bell
          mug" — defined as a conversion to a standard unit (e.g.
          <code> 1 dollop = 1 tbsp</code>). They'll show up here once
          you add them in <em>Settings → Conversions</em>. Until then,
          pick the closest standard unit and you can scale later in
          the recipe view.
        </span>
      )}
    </span>
  );
}

function quantityAmountText(q: Quantity): string {
  switch (q.type) {
    case 'EXACT':
      return String(q.amount);
    case 'FRACTIONAL':
      return q.whole > 0
        ? `${q.whole} ${q.numerator}/${q.denominator}`
        : `${q.numerator}/${q.denominator}`;
    case 'RANGE':
      return `${q.min}-${q.max}`;
  }
}

function MergedPagesStrip({
  primaryPath,
  extras,
  activeUrl,
  onPick,
}: {
  primaryPath: string;
  extras: readonly string[];
  activeUrl: string | undefined;
  onPick: (path: string) => void;
}) {
  const all = [primaryPath, ...extras];
  return (
    <div className="rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-2">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-stone-700 dark:text-stone-300">
          Merged scans ({all.length})
        </span>
        <span className="text-stone-500 dark:text-stone-400">
          All sent to the LLM together. Click a thumb to inspect.
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto">
        {all.map((p, i) => (
          <button
            type="button"
            key={p}
            onClick={() => onPick(p)}
            className={`relative shrink-0 overflow-hidden rounded border ${
              activeUrl?.includes(p.split('/').pop() ?? '__none__')
                ? 'border-stone-900 ring-2 ring-stone-900'
                : 'border-stone-200 hover:border-stone-400'
            }`}
            title={i === 0 ? 'Primary' : `Merged page ${i}`}
          >
            <ImportThumb path={p} className="h-20 w-16 object-cover" />
            <span className="absolute bottom-0 left-0 rounded-tr bg-stone-900/80 px-1 text-[10px] text-white">
              {i === 0 ? 'primary' : `+${i}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ToastBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded-full bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 shadow-lg"
    >
      {message}
    </div>
  );
}

function NavBanner({
  batchName,
  batchId,
  prevId,
  nextId,
  position,
  currentPageIndex,
  save,
}: {
  batchName: string;
  batchId: string;
  prevId: string | undefined;
  nextId: string | undefined;
  position: { current: number; total: number } | undefined;
  currentPageIndex: number;
  save?: {
    onSave: () => void;
    disabled: boolean;
    saving: boolean;
    label: string;
  };
}) {
  return (
    <div className="sticky top-0 z-20 -mx-4 flex items-center gap-3 border-b border-stone-200 dark:border-stone-700 bg-white/95 px-4 py-2 text-sm backdrop-blur">
      <Link to={`/import/${batchId}`} className="truncate text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100">
        ← {batchName}
      </Link>
      {save && (
        <button
          type="button"
          onClick={save.onSave}
          disabled={save.disabled}
          title={
            save.disabled && !save.saving
              ? 'Pick a cookbook below before saving'
              : save.label
          }
          className="ml-2 truncate rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
        >
          {save.saving ? 'Saving…' : save.label}
        </button>
      )}
      <div className="ml-auto flex items-center gap-1">
        {prevId ? (
          <Link
            to={`/import/${batchId}/items/${prevId}`}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-800"
            title="Previous reviewable (← or k)"
          >
            ← Prev
          </Link>
        ) : (
          <span className="rounded-md border border-stone-200 dark:border-stone-700 px-2 py-1 text-xs text-stone-400">
            ← Prev
          </span>
        )}
        <span className="px-2 text-xs text-stone-500 dark:text-stone-400">
          {position
            ? `${position.current} of ${position.total}`
            : `Page ${currentPageIndex}`}
        </span>
        {nextId ? (
          <Link
            to={`/import/${batchId}/items/${nextId}`}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-800"
            title="Next reviewable (→ or j)"
          >
            Next →
          </Link>
        ) : (
          <span className="rounded-md border border-stone-200 dark:border-stone-700 px-2 py-1 text-xs text-stone-400">
            Next →
          </span>
        )}
      </div>
    </div>
  );
}

function FullscreenImage({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label={alt}
      className="fixed inset-0 z-50 bg-stone-900/95"
      onClick={onClose}
    >
      <div
        className="absolute inset-0"
        // The PinchPanImage hosts its own gesture handlers; stop the click
        // from bubbling to the backdrop's onClick={onClose}.
        onClick={(e) => e.stopPropagation()}
      >
        <PinchPanImage src={src} alt={alt} className="relative h-full w-full" />
      </div>
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 rounded-full bg-white/90 px-3 py-1.5 text-sm font-medium text-stone-900 dark:text-stone-100 hover:bg-white dark:hover:bg-stone-800"
      >
        Close (esc)
      </button>
    </div>
  );
}

/**
 * Strict page-index neighbour — the next or previous item in the
 * batch by `pageIndex`, with no status filter. Used by the keyboard
 * shortcuts and the prev/next nav banner so the user can step
 * through their stack sequentially, REVIEWED pages and all.
 */
function findAdjacent<T extends { id: string; pageIndex: number }>(
  items: readonly T[],
  currentId: string,
  direction: 'next' | 'prev',
): T | undefined {
  const sorted = [...items].sort((a, b) => a.pageIndex - b.pageIndex);
  const idx = sorted.findIndex((i) => i.id === currentId);
  if (idx < 0) return undefined;
  const target = direction === 'next' ? idx + 1 : idx - 1;
  return sorted[target];
}

/**
 * Walk the batch in page order. `next` walks forward and wraps around;
 * `prev` walks backward. Returns the first reviewable item it finds
 * (any non-terminal status), or undefined if none remain. Used by
 * save / discard auto-advance — the "jump to the next thing that
 * still needs attention" path. Distinct from findAdjacent which is
 * for sequential browsing.
 */
function findReviewable<T extends { id: string; status: string; pageIndex: number }>(
  items: readonly T[],
  currentId: string,
  direction: 'next' | 'prev',
): T | undefined {
  const sorted = [...items].sort((a, b) => a.pageIndex - b.pageIndex);
  const idx = sorted.findIndex((i) => i.id === currentId);
  if (idx < 0) return sorted[0];
  const ring = direction === 'next'
    ? [...sorted.slice(idx + 1), ...sorted.slice(0, idx)]
    : [...sorted.slice(0, idx).reverse(), ...sorted.slice(idx + 1).reverse()];
  return ring.find(
    (i) =>
      i.status === 'OCR_DONE' ||
      i.status === 'NEEDS_FALLBACK' ||
      i.status === 'PENDING' ||
      i.status === 'CLAIMED',
  );
}

/**
 * Show a transient toast. Auto-dismiss after `ms`. Caller owns the
 * setter so the toast renders inside the page without needing a
 * separate provider.
 */
function showToast(
  setToast: (m: string | undefined) => void,
  message: string,
  ms = 3500,
): void {
  setToast(message);
  window.setTimeout(() => setToast(undefined), ms);
}

function DraftEditor({
  draft,
  onPatch,
}: {
  draft: ParsedRecipeDraft;
  onPatch: (p: Partial<ParsedRecipeDraft>) => void;
}) {
  function patchIngredient(idx: number, next: Ingredient): void {
    onPatch({ ingredients: draft.ingredients.map((ing, i) => (i === idx ? next : ing)) });
  }
  function removeIngredient(idx: number): void {
    const removed = draft.ingredients[idx];
    if (!removed) return;
    const nextIngredients = draft.ingredients.filter((_, i) => i !== idx);
    // Drop any step refs that pointed at the now-gone ingredient.
    const nextInstructions = draft.instructions.map((step) =>
      step.ingredientRefs.some((r) => r.ingredientId === removed.id)
        ? instruction({
            id: step.id,
            stepNumber: step.stepNumber,
            text: step.text,
            ingredientRefs: step.ingredientRefs.filter((r) => r.ingredientId !== removed.id),
            temperature: step.temperature,
            subInstructions: step.subInstructions,
            notes: step.notes,
          })
        : step,
    );
    onPatch({ ingredients: nextIngredients, instructions: nextInstructions });
  }
  function addIngredient(): void {
    onPatch({ ingredients: [...draft.ingredients, vague({ name: 'new ingredient' })] });
  }
  function patchInstruction(idx: number, next: Instruction): void {
    onPatch({ instructions: draft.instructions.map((s, i) => (i === idx ? next : s)) });
  }
  function removeInstruction(idx: number): void {
    onPatch({ instructions: draft.instructions.filter((_, i) => i !== idx) });
  }
  function addInstruction(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    onPatch({
      instructions: [
        ...draft.instructions,
        instruction({
          stepNumber: draft.instructions.length + 1,
          text: trimmed,
          ingredientRefs: [],
        }),
      ],
    });
  }

  return (
    <article className="space-y-5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-5">
      <header className="space-y-2">
        <EditableText
          value={draft.title ?? ''}
          placeholder="(no title)"
          onCommit={(v) => onPatch({ title: v.trim() || undefined })}
          className="block w-full text-2xl font-semibold leading-tight text-stone-900 dark:text-stone-100"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
          {/* The recipe's bookTitle is sourced from the assigned
              cookbook on save (see saveAsRecipe). We don't render a
              separate editable "from" field here — it was redundant
              with the Cookbook combobox below and confused users. */}
          <Inline label="time">
            <EditableText
              value={draft.timeEstimate ?? ''}
              placeholder="(time)"
              onCommit={(v) => onPatch({ timeEstimate: v.trim() || undefined })}
            />
          </Inline>
        </div>
      </header>

      <section>
        <EditableText
          multiline
          value={draft.description ?? ''}
          placeholder="(no description — click to add)"
          onCommit={(v) => onPatch({ description: v.trim() || undefined })}
          className="block w-full text-sm leading-relaxed text-stone-700 dark:text-stone-300"
        />
      </section>

      <EquipmentRow
        equipment={draft.equipment}
        onChange={(next) => onPatch({ equipment: next.length > 0 ? next : undefined })}
      />

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Ingredients
        </h3>
        <ul className="space-y-1">
          {draft.ingredients.map((ing, i) => (
            <IngredientRow
              key={ing.id}
              ingredient={ing}
              onChange={(next) => patchIngredient(i, next)}
              onRemove={() => removeIngredient(i)}
            />
          ))}
          <li>
            <button
              type="button"
              onClick={addIngredient}
              className="text-xs text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
            >
              + Add ingredient
            </button>
          </li>
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Instructions
        </h3>
        <ol className="space-y-4">
          {draft.instructions.map((step, i) => (
            <InstructionRow
              key={step.id}
              step={step}
              index={i}
              availableIngredients={draft.ingredients}
              onChange={(next) => patchInstruction(i, next)}
              onRemove={() => removeInstruction(i)}
            />
          ))}
          <li className="flex gap-3">
            <span className="w-6 shrink-0 pt-0.5 text-right text-xs font-medium text-stone-400">
              {draft.instructions.length + 1}.
            </span>
            <EditableText
              multiline
              value=""
              placeholder="+ Add step"
              onCommit={(v) => addInstruction(v)}
              className="flex-1 text-stone-400"
            />
          </li>
        </ol>
      </section>

      {draft.sourceImageText && (
        <details className="text-xs">
          <summary className="cursor-pointer text-stone-500 dark:text-stone-400">Raw OCR text</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-stone-50 dark:bg-stone-900 p-2 text-stone-700 dark:text-stone-300">
            {draft.sourceImageText}
          </pre>
        </details>
      )}
    </article>
  );
}

function IngredientRow({
  ingredient,
  onChange,
  onRemove,
}: {
  ingredient: Ingredient;
  onChange: (next: Ingredient) => void;
  onRemove: () => void;
}) {
  function commitQuantity(input: string) {
    const result = parseQuantityInput(input);
    if (result === undefined) return; // unparseable: leave as-is
    if (result === 'CLEAR') {
      onChange(
        vague({
          id: ingredient.id,
          name: ingredient.name,
          preparation: ingredient.preparation,
          notes: ingredient.notes,
          description: isMeasured(ingredient) ? undefined : ingredient.description,
        }),
      );
      return;
    }
    onChange(
      measured({
        id: ingredient.id,
        name: ingredient.name,
        preparation: ingredient.preparation,
        notes: ingredient.notes,
        quantity: result,
      }),
    );
  }
  function commitName(v: string) {
    const name = v.trim();
    if (!name) {
      onRemove();
      return;
    }
    if (isMeasured(ingredient)) {
      onChange(
        measured({
          id: ingredient.id,
          name,
          preparation: ingredient.preparation,
          notes: ingredient.notes,
          quantity: ingredient.quantity,
        }),
      );
    } else {
      onChange(
        vague({
          id: ingredient.id,
          name,
          preparation: ingredient.preparation,
          notes: ingredient.notes,
          description: ingredient.description,
        }),
      );
    }
  }
  function commitPrep(v: string) {
    const preparation = v.trim() || undefined;
    if (isMeasured(ingredient)) {
      onChange(
        measured({
          id: ingredient.id,
          name: ingredient.name,
          preparation,
          notes: ingredient.notes,
          quantity: ingredient.quantity,
        }),
      );
    } else {
      onChange(
        vague({
          id: ingredient.id,
          name: ingredient.name,
          preparation,
          notes: ingredient.notes,
          description: ingredient.description,
        }),
      );
    }
  }

  return (
    <li className="group flex items-baseline gap-2 text-sm leading-relaxed text-stone-800 dark:text-stone-200">
      <QuantityEditor
        quantity={isMeasured(ingredient) ? ingredient.quantity : undefined}
        onChange={(q) =>
          onChange(
            measured({
              id: ingredient.id,
              name: ingredient.name,
              preparation: ingredient.preparation,
              notes: ingredient.notes,
              quantity: q,
            }),
          )
        }
        onClear={() => commitQuantity('')}
      />
      <EditableText
        value={ingredient.name}
        placeholder="(ingredient)"
        onCommit={commitName}
        className="font-medium"
      />
      <span className="text-stone-300">·</span>
      <EditableText
        value={ingredient.preparation ?? ''}
        placeholder="(prep)"
        onCommit={commitPrep}
        className="text-stone-500 dark:text-stone-400"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove ingredient"
        className="ml-auto rounded px-1 text-xs text-stone-300 opacity-0 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 group-hover:opacity-100"
      >
        ×
      </button>
    </li>
  );
}

function InstructionRow({
  step,
  index,
  availableIngredients,
  onChange,
  onRemove,
}: {
  step: Instruction;
  index: number;
  availableIngredients: readonly Ingredient[];
  onChange: (next: Instruction) => void;
  onRemove: () => void;
}) {
  const refIds = new Set(step.ingredientRefs.map((r) => r.ingredientId));
  const refsById = new Map(availableIngredients.map((ing) => [ing.id, ing]));
  const unlinked = availableIngredients.filter((ing) => !refIds.has(ing.id));

  function commitText(v: string) {
    const text = v.trim();
    if (!text) {
      onRemove();
      return;
    }
    onChange(
      instruction({
        id: step.id,
        stepNumber: step.stepNumber,
        text,
        ingredientRefs: [...step.ingredientRefs],
        temperature: step.temperature,
        subInstructions: step.subInstructions,
        notes: step.notes,
      }),
    );
  }
  function toggleRef(ingredientId: string) {
    const next = refIds.has(ingredientId)
      ? step.ingredientRefs.filter((r) => r.ingredientId !== ingredientId)
      : [...step.ingredientRefs, { ingredientId }];
    onChange(
      instruction({
        id: step.id,
        stepNumber: step.stepNumber,
        text: step.text,
        ingredientRefs: next,
        temperature: step.temperature,
        subInstructions: step.subInstructions,
        notes: step.notes,
      }),
    );
  }

  return (
    <li className="group flex gap-3 text-sm leading-relaxed text-stone-800 dark:text-stone-200">
      <span className="w-6 shrink-0 pt-0.5 text-right text-xs font-medium text-stone-400">
        {index + 1}.
      </span>
      <div className="flex-1 space-y-1.5">
        <EditableText
          multiline
          value={step.text}
          placeholder="(click to edit; leave blank to remove)"
          onCommit={commitText}
          className="block w-full"
        />
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {step.ingredientRefs.map((ref) => {
            const ing = refsById.get(ref.ingredientId);
            return (
              <button
                key={ref.ingredientId}
                type="button"
                onClick={() => toggleRef(ref.ingredientId)}
                title="Click to remove"
                className="inline-flex items-center gap-1 rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-xs text-stone-700 dark:text-stone-300 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-700"
              >
                <span>{ing?.name ?? '(missing)'}</span>
                <span className="text-stone-400">×</span>
              </button>
            );
          })}
          {unlinked.length > 0 && (
            <AddRefMenu
              options={unlinked}
              onPick={(id) => toggleRef(id)}
            />
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove step"
        className="self-start rounded px-1 pt-1 text-xs text-stone-300 opacity-0 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 group-hover:opacity-100"
      >
        ×
      </button>
    </li>
  );
}

function AddRefMenu({
  options,
  onPick,
}: {
  options: readonly Ingredient[];
  onPick: (id: string) => void;
}) {
  return (
    <select
      value=""
      onChange={(e) => {
        const v = e.target.value;
        if (v) onPick(v);
        e.target.value = '';
      }}
      className="rounded-full border border-dashed border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-0.5 text-xs text-stone-500 dark:text-stone-400 hover:border-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
    >
      <option value="">+ link</option>
      {options.map((ing) => (
        <option key={ing.id} value={ing.id}>
          {ing.name}
        </option>
      ))}
    </select>
  );
}

function EquipmentRow({
  equipment,
  onChange,
}: {
  equipment: readonly string[] | undefined;
  onChange: (next: string[]) => void;
}) {
  const items = equipment ?? [];
  function add(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (items.some((e) => e.toLowerCase() === trimmed.toLowerCase())) return;
    onChange([...items, trimmed]);
  }
  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }
  function update(idx: number, value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      remove(idx);
      return;
    }
    onChange(items.map((e, i) => (i === idx ? trimmed : e)));
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
        Equipment
      </h3>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.length === 0 && (
          <span className="text-xs text-stone-400">
            (none — add what the recipe needs)
          </span>
        )}
        {items.map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="group inline-flex items-center gap-1 rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-xs text-stone-700 dark:text-stone-300"
          >
            <EditableText
              value={item}
              placeholder="(equipment)"
              onCommit={(v) => update(i, v)}
              className="inline"
            />
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label="Remove equipment"
              className="text-stone-400 hover:text-red-700"
            >
              ×
            </button>
          </span>
        ))}
        <EditableText
          value=""
          placeholder="+ add"
          onCommit={add}
          className="rounded-full border border-dashed border-stone-300 dark:border-stone-600 px-2 py-0.5 text-xs text-stone-500 dark:text-stone-400 hover:border-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
        />
      </div>
    </section>
  );
}

/**
 * View-first inline edit. Renders the value as plain text; click swaps
 * it for an input that commits on blur or Enter (or Escape to cancel).
 * Multiline mode uses a textarea and only commits on blur — Enter
 * inserts a newline.
 */
function EditableText({
  value,
  onCommit,
  multiline = false,
  className = '',
  placeholder = 'click to edit',
}: {
  value: string;
  onCommit: (next: string) => void;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function commit() {
    if (draft !== value) onCommit(draft);
    setEditing(false);
  }
  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  if (!editing) {
    const empty = value.length === 0;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={`group rounded text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none ${className}`}
      >
        {empty ? (
          <span className="text-stone-400">{placeholder}</span>
        ) : (
          <span className="whitespace-pre-wrap">{value}</span>
        )}
      </button>
    );
  }

  if (multiline) {
    return (
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        rows={Math.max(2, Math.ceil(Math.max(draft.length, value.length) / 60))}
        className={`rounded border border-stone-300 bg-white px-2 py-1 outline-none focus:border-stone-500 ${className}`}
      />
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      className={`rounded border border-stone-300 bg-white px-2 py-1 outline-none focus:border-stone-500 ${className}`}
    />
  );
}

function Inline({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-stone-400">{label}</span>
      {children}
    </span>
  );
}

function ViewRawLink({ path }: { path: string }) {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    void getSignedImportUrl(path)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-xs text-stone-700 dark:text-stone-300 underline hover:text-stone-900 dark:hover:text-stone-100"
    >
      View raw response →
    </a>
  );
}

function Spinner({ className = '', label }: { className?: string; label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-700 dark:text-stone-300">{label}</span>
      {children}
    </label>
  );
}

/**
 * Target-cookbook picker with an inline "create a new cookbook" form.
 * Self-contained — owns its own create state and persistence — so both
 * the recipe-save path and the ToC placeholder path can drop it in
 * without duplicating the create flow. On a successful create it selects
 * the new cookbook via `onChange`.
 */
function CookbookField({
  options,
  value,
  onChange,
  loading = false,
  matchedExistingTitle,
}: {
  options: readonly CollectionPickerOption[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  matchedExistingTitle?: string;
}) {
  const saveCollection = useSaveCollection();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [error, setError] = useState<string | undefined>();

  if (creating) {
    return (
      <div className="space-y-2 rounded border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-900 p-2">
        <input
          autoFocus
          placeholder="Cookbook title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-sm"
        />
        <input
          placeholder="Author (optional)"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          className="w-full rounded border border-stone-300 dark:border-stone-600 px-2 py-1 text-sm"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={async () => {
              const t = title.trim();
              if (!t) return;
              const cookbook: RecipeCollection = createCookbook({
                title: t,
                author: author.trim() || undefined,
              });
              try {
                await saveCollection.mutateAsync(cookbook);
                onChange(cookbook.id);
                setCreating(false);
                setTitle('');
                setAuthor('');
                setError(undefined);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            disabled={!title.trim() || saveCollection.isPending}
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1 text-xs font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50"
          >
            {saveCollection.isPending ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setTitle('');
              setAuthor('');
            }}
            className="rounded-md px-3 py-1 text-xs text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
      </div>
    );
  }

  return (
    <>
      <CookbookCombobox
        options={options}
        value={value}
        onChange={onChange}
        onCreateNew={() => setCreating(true)}
        loading={loading}
        matchedExistingTitle={matchedExistingTitle}
      />
      {!loading && options.length === 0 && (
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          No cookbooks yet — create one to save this recipe.
        </p>
      )}
    </>
  );
}

/**
 * Per-item "Delete uploaded image" button. Wipes the storage paths
 * (primary, thumb, source PDF, extra merged pages) for one item.
 * Recipes promoted from this item stay; only the source picture goes
 * away. The button is hidden when `hasImage` is false because there's
 * nothing left to delete.
 */
function ItemDeleteStorageButton({ itemId, hasImage }: { itemId: string; hasImage: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { syncNow } = useSync();

  if (!hasImage) return null;

  async function onClick() {
    if (
      !confirm(
        'Delete the uploaded image for this item? The OCR result and any recipes promoted from it will stay. This cannot be undone.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteOcrStorage({ kind: 'item', itemId });
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
        data-testid="item-delete-storage"
        className="rounded-md px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-60"
      >
        {busy ? 'Deleting image…' : 'Delete uploaded image'}
      </button>
      {error && (
        <span className="text-xs text-red-700 dark:text-red-300">{error}</span>
      )}
    </>
  );
}
