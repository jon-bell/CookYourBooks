import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  createRecipe,
  createCookbook,
  formatQuantity,
  isMeasured,
  measured,
  parseIngredientLine,
  vague,
  instruction,
  type Ingredient,
  type Instruction,
  type ParsedRecipeDraft,
  type Quantity,
  type RecipeCollection,
} from '@cookyourbooks/domain';
import {
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
import { kickOcr } from '../import/api.js';
import { OcrStatusBanner } from '../import/OcrStatusBanner.js';
import { canReOcr } from '../import/ocrStatus.js';
import { useSync } from '../local/SyncProvider.js';
import { getSignedImportUrl, ImportThumb } from '../import/ImportThumb.js';
import { suggestTocMatches } from '../import/tocMatch.js';

export function ImportItemPage() {
  const { batchId, itemId } = useParams();
  const { data: batch, isLoading: batchLoading } = useImportBatch(batchId);
  const { data: item, isLoading: itemLoading } = useImportItem(itemId);
  const { data: batchItems = [] } = useImportItems(batchId);
  const { data: attempts = [] } = useImportItemAttempts(itemId);
  const { data: tocEntries = [] } = useImportTocEntries(batchId);
  const { data: pickerOptions = [], isLoading: pickerLoading } = useCollectionPickerOptions();
  const saveCollection = useSaveCollection();
  const updateItem = useUpdateImportItem();
  const { syncNow, status: syncStatus, localReady, hydrated } = useSync();
  const navigate = useNavigate();

  const [activeDraft, setActiveDraft] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imgUrl, setImgUrl] = useState<string | undefined>();
  const [assignedCollectionId, setAssignedCollectionId] = useState<string>('');
  const [pageNumberStr, setPageNumberStr] = useState('');
  const [showTocSuggestions, setShowTocSuggestions] = useState(false);
  const [draftPatches, setDraftPatches] = useState<Record<number, ParsedRecipeDraft>>({});
  const [creatingCookbook, setCreatingCookbook] = useState(false);
  const [newCookbookTitle, setNewCookbookTitle] = useState('');
  const [newCookbookAuthor, setNewCookbookAuthor] = useState('');
  const [cookbookError, setCookbookError] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const viewerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ active: boolean; startX: number; startY: number; origX: number; origY: number } | null>(null);

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

  const tocSuggestions = useMemo(
    () =>
      currentDraft?.title
        ? suggestTocMatches(currentDraft.title, tocEntries, { limit: 5 })
        : [],
    [currentDraft?.title, tocEntries],
  );

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

  if (!localReady || batchLoading || itemLoading) {
    return <p className="text-stone-500">Loading…</p>;
  }
  if ((!batch || !item) && !hydrated) {
    return <p className="text-stone-500">Initializing local cache…</p>;
  }
  if (!batch || !item) {
    return (
      <div className="space-y-3">
        <p className="text-stone-700">
          {!batch ? 'Batch' : 'Item'} not found locally.
        </p>
        <p className="text-sm text-stone-500">
          It may not have synced from the server yet ({syncStatus}).
        </p>
        <button
          type="button"
          onClick={() => void syncNow()}
          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
        >
          Sync now
        </button>
      </div>
    );
  }

  const targetCollectionId =
    assignedCollectionId || batch.targetCollectionId || '';

  const reOcrAllowed = canReOcr(item.status);

  async function toggleIsToc() {
    if (!item) return;
    const next = !item.isToc;
    await updateItem.mutateAsync({
      id: item.id,
      patch: {
        isToc: next,
        status: next ? 'PENDING' : item.status,
        // Drop drafts when promoting to ToC so the worker re-OCRs.
        parsedDrafts: next ? [] : item.parsedDrafts,
      },
    });
    if (next) {
      try {
        await kickOcr(batch!.id);
      } catch {
        // pg_cron will pick up the slack.
      }
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
    // Re-mint ingredient + instruction ids so a retry (or two drafts
    // happening to share an id) never trips the global UNIQUE on
    // ingredients.id / instructions.id.
    const { ingredients, instructions } = withFreshIds(currentDraft);
    const recipe = createRecipe({
      title: currentDraft.title?.trim() || 'Untitled',
      servings: currentDraft.servings,
      ingredients,
      instructions,
      description: currentDraft.description,
      timeEstimate: currentDraft.timeEstimate,
      equipment: currentDraft.equipment,
      bookTitle: currentDraft.bookTitle,
      pageNumbers,
      sourceImageText: currentDraft.sourceImageText,
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
      const nextItem = findNextReviewable(batchItems, item.id);
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
      const nextItem = findNextReviewable(batchItems, item.id);
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
    if (!item) return;
    await updateItem.mutateAsync({
      id: item.id,
      patch: { parsedDrafts: [], status: 'PENDING' },
    });
    try {
      await kickOcr(batch!.id);
    } catch {
      // pg_cron will retry.
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
      <div className="flex items-center gap-2 text-sm text-stone-600">
        <Link to={`/import/${batch.id}`} className="underline">
          ← {batch.name}
        </Link>
        <span>·</span>
        <span>Page {item.pageIndex + 1}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div
            ref={viewerRef}
            onWheel={onWheel}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            className="relative aspect-[3/4] cursor-grab overflow-hidden rounded-lg border border-stone-200 bg-stone-100"
          >
            {imgUrl ? (
              <img
                src={imgUrl}
                alt={`Page ${item.pageIndex + 1}`}
                className="absolute left-1/2 top-1/2 max-w-none select-none"
                draggable={false}
                style={{
                  transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: 'center',
                }}
              />
            ) : (
              <ImportThumb path={item.storagePath} className="h-full w-full object-contain" />
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-stone-600">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
              className="rounded border border-stone-300 px-2 py-0.5 hover:bg-stone-100"
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
              className="rounded border border-stone-300 px-2 py-0.5 hover:bg-stone-100"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="ml-2 rounded border border-stone-300 px-2 py-0.5 hover:bg-stone-100"
            >
              Reset
            </button>
            <span className="ml-auto text-stone-500">Ctrl/⌘+scroll to zoom · drag to pan</span>
          </div>

          <details className="rounded-md border border-stone-200 bg-white">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              Attempt history ({attempts.length})
            </summary>
            <ul className="divide-y divide-stone-200 px-3 pb-2 text-xs text-stone-700">
              {attempts.length === 0 && <li className="py-2 text-stone-500">No attempts yet.</li>}
              {attempts.map((a) => (
                <li key={a.id} className="space-y-0.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">#{a.attemptNo}</span>
                    <span>{a.provider}</span>
                    <code className="rounded bg-stone-100 px-1">{a.model}</code>
                    <span
                      className={
                        a.errorKind && a.errorKind !== 'OK'
                          ? 'text-red-700'
                          : 'text-emerald-700'
                      }
                    >
                      {a.errorKind ?? 'OK'}
                    </span>
                    <span className="ml-auto text-stone-500">
                      {a.latencyMs}ms · ${(a.costUsdMicros / 1_000_000).toFixed(4)}
                    </span>
                  </div>
                  {a.errorMessage && (
                    <div className="text-stone-600">{a.errorMessage}</div>
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

          <div className="rounded-md border border-stone-200 bg-white p-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={item.isToc}
                onChange={() => void toggleIsToc()}
              />
              <span>This is a Table of Contents page</span>
            </label>
          </div>

          {!item.isToc && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cookbook">
                  {creatingCookbook ? (
                    <div className="space-y-2 rounded border border-stone-300 bg-stone-50 p-2">
                      <input
                        autoFocus
                        placeholder="Cookbook title"
                        value={newCookbookTitle}
                        onChange={(e) => setNewCookbookTitle(e.target.value)}
                        className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                      />
                      <input
                        placeholder="Author (optional)"
                        value={newCookbookAuthor}
                        onChange={(e) => setNewCookbookAuthor(e.target.value)}
                        className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            const title = newCookbookTitle.trim();
                            if (!title) return;
                            const cookbook: RecipeCollection = createCookbook({
                              title,
                              author: newCookbookAuthor.trim() || undefined,
                            });
                            try {
                              await saveCollection.mutateAsync(cookbook);
                              setAssignedCollectionId(cookbook.id);
                              setCreatingCookbook(false);
                              setNewCookbookTitle('');
                              setNewCookbookAuthor('');
                              setCookbookError(undefined);
                            } catch (err) {
                              setCookbookError((err as Error).message);
                            }
                          }}
                          disabled={!newCookbookTitle.trim() || saveCollection.isPending}
                          className="rounded-md bg-stone-900 px-3 py-1 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
                        >
                          {saveCollection.isPending ? 'Creating…' : 'Create'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCreatingCookbook(false);
                            setNewCookbookTitle('');
                            setNewCookbookAuthor('');
                          }}
                          className="rounded-md px-3 py-1 text-xs text-stone-600 hover:text-stone-900"
                        >
                          Cancel
                        </button>
                      </div>
                      {cookbookError && (
                        <p className="text-xs text-red-700">{cookbookError}</p>
                      )}
                    </div>
                  ) : (
                    <>
                      <select
                        value={assignedCollectionId}
                        onChange={(e) => {
                          if (e.target.value === '__new__') setCreatingCookbook(true);
                          else setAssignedCollectionId(e.target.value);
                        }}
                        className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                      >
                        <option value="">(unassigned)</option>
                        {pickerOptions.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                        <option value="__new__">+ Create new cookbook…</option>
                      </select>
                      {pickerLoading && (
                        <p className="mt-1 text-xs text-stone-500">Loading cookbooks…</p>
                      )}
                      {!pickerLoading && pickerOptions.length === 0 && (
                        <p className="mt-1 text-xs text-stone-500">
                          No cookbooks yet — create one to save this recipe.
                        </p>
                      )}
                    </>
                  )}
                </Field>
                <Field label="Page number">
                  <div className="relative">
                    <input
                      value={pageNumberStr}
                      onChange={(e) => setPageNumberStr(e.target.value)}
                      onFocus={() => setShowTocSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowTocSuggestions(false), 150)}
                      className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                      placeholder="e.g. 42"
                    />
                    {showTocSuggestions && tocSuggestions.length > 0 && (
                      <div className="absolute z-20 mt-1 w-full rounded-md border border-stone-200 bg-white shadow-md">
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
                                className="block w-full px-3 py-1.5 text-left hover:bg-stone-100"
                              >
                                <span className="font-medium">{s.entry.title}</span>
                                {s.entry.pageNumber != null && (
                                  <span className="ml-2 text-stone-500">
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
              </div>

              {drafts.length > 1 && (
                <div className="flex gap-1 border-b border-stone-200">
                  {drafts.map((d, i) => (
                    <button
                      key={i}
                      type="button"
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

              {currentDraft ? (
                <DraftEditor draft={currentDraft} onPatch={patchDraft} />
              ) : item.status === 'OCR_FAILED' ? (
                <p className="text-sm text-red-700">
                  OCR failed{item.lastError ? `: ${item.lastError}` : '.'} Use Re-OCR to try
                  again.
                </p>
              ) : (
                <p className="text-sm text-stone-600">No drafts yet — OCR results will appear here.</p>
              )}

              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void saveAsRecipe()}
                  disabled={!currentDraft || !targetCollectionId || saveRecipe.isPending}
                  className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
                >
                  {saveRecipe.isPending ? 'Saving…' : 'Save as recipe'}
                </button>
                <button
                  type="button"
                  onClick={() => void discardThisDraft()}
                  disabled={!currentDraft}
                  className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-50"
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
                  className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Re-OCR
                </button>
                <button
                  type="button"
                  onClick={() => void discardItem()}
                  className="rounded-md px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                >
                  Discard entire item
                </button>
              </div>

              {(actionError || saveRecipe.isError) && (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
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

/**
 * Walk the batch in page order and find the next item that still has
 * something to do (OCR_DONE with drafts, NEEDS_FALLBACK, or anything
 * non-terminal). Skip the current item. Used to chain the import
 * workflow so the user can keep moving without bouncing back to the
 * batch board after each save.
 */
function findNextReviewable(
  items: Array<{ id: string; status: string; pageIndex: number }>,
  currentId: string,
): { id: string } | undefined {
  const sorted = [...items].sort((a, b) => a.pageIndex - b.pageIndex);
  const idx = sorted.findIndex((i) => i.id === currentId);
  const ring = idx >= 0 ? [...sorted.slice(idx + 1), ...sorted.slice(0, idx)] : sorted;
  return ring.find(
    (i) =>
      i.status === 'OCR_DONE' ||
      i.status === 'NEEDS_FALLBACK' ||
      i.status === 'PENDING' ||
      i.status === 'CLAIMED',
  );
}

/**
 * Clone a draft's ingredients + instructions with fresh ids and remap
 * step→ingredient refs through the id map. Without this, promoting a
 * draft to a real recipe collides on the global UNIQUE(ingredients.id)
 * any time the user retries a save, or two drafts on the same image
 * happened to share an id.
 */
function withFreshIds(draft: ParsedRecipeDraft): { ingredients: Ingredient[]; instructions: Instruction[] } {
  const idMap = new Map<string, string>();
  const ingredients: Ingredient[] = draft.ingredients.map((ing) => {
    const newId = crypto.randomUUID();
    idMap.set(ing.id, newId);
    if (isMeasured(ing)) {
      return measured({
        id: newId,
        name: ing.name,
        preparation: ing.preparation,
        notes: ing.notes,
        quantity: ing.quantity,
      });
    }
    return vague({
      id: newId,
      name: ing.name,
      preparation: ing.preparation,
      notes: ing.notes,
      description: ing.description,
    });
  });
  const instructions: Instruction[] = draft.instructions.map((step, i) =>
    instruction({
      id: crypto.randomUUID(),
      stepNumber: i + 1,
      text: step.text,
      ingredientRefs: step.ingredientRefs
        .map((ref) => {
          const nextId = idMap.get(ref.ingredientId);
          if (!nextId) return undefined;
          return { ingredientId: nextId, quantity: ref.quantity };
        })
        .filter((r): r is { ingredientId: string; quantity: typeof step.ingredientRefs[number]['quantity'] } => r !== undefined),
      temperature: step.temperature,
      subInstructions: step.subInstructions,
      notes: step.notes,
    }),
  );
  return { ingredients, instructions };
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
    <article className="space-y-5 rounded-md border border-stone-200 bg-white p-5">
      <header className="space-y-2">
        <EditableText
          value={draft.title ?? ''}
          placeholder="(no title)"
          onCommit={(v) => onPatch({ title: v.trim() || undefined })}
          className="block w-full text-2xl font-semibold leading-tight text-stone-900"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
          <Inline label="from">
            <EditableText
              value={draft.bookTitle ?? ''}
              placeholder="(book title)"
              onCommit={(v) => onPatch({ bookTitle: v.trim() || undefined })}
              className="italic"
            />
          </Inline>
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
          className="block w-full text-sm leading-relaxed text-stone-700"
        />
      </section>

      <EquipmentRow
        equipment={draft.equipment}
        onChange={(next) => onPatch({ equipment: next.length > 0 ? next : undefined })}
      />

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
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
              className="text-xs text-stone-500 hover:text-stone-900"
            >
              + Add ingredient
            </button>
          </li>
        </ul>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
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
          <summary className="cursor-pointer text-stone-500">Raw OCR text</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-2 text-stone-700">
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

  const qtyText = isMeasured(ingredient) ? formatQuantity(ingredient.quantity) : '';
  return (
    <li className="group flex items-baseline gap-2 text-sm leading-relaxed text-stone-800">
      <EditableText
        value={qtyText}
        placeholder="(no qty)"
        onCommit={commitQuantity}
        className="inline-block min-w-[3rem] rounded-md bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700"
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
        className="text-stone-500"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove ingredient"
        className="ml-auto rounded px-1 text-xs text-stone-300 opacity-0 hover:bg-stone-100 hover:text-stone-900 group-hover:opacity-100"
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
    <li className="group flex gap-3 text-sm leading-relaxed text-stone-800">
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
                className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700 hover:bg-red-50 hover:text-red-700"
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
        className="self-start rounded px-1 pt-1 text-xs text-stone-300 opacity-0 hover:bg-stone-100 hover:text-stone-900 group-hover:opacity-100"
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
      className="rounded-full border border-dashed border-stone-300 bg-white px-2 py-0.5 text-xs text-stone-500 hover:border-stone-500 hover:text-stone-900"
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
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
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
            className="group inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700"
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
          className="rounded-full border border-dashed border-stone-300 px-2 py-0.5 text-xs text-stone-500 hover:border-stone-500 hover:text-stone-900"
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
      className="text-xs text-stone-700 underline hover:text-stone-900"
    >
      View raw response →
    </a>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-700">{label}</span>
      {children}
    </label>
  );
}
