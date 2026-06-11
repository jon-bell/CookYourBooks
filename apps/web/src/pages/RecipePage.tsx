import {
  adaptRecipe,
  createRegistry,
  exact,
  formatQuantity,
  type Quantity,
  recipeToMarkdown,
  scaleRecipe,
  StandardConversions,
  Units,
} from '@cookyourbooks/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { DropdownMenu, DropdownMenuItem } from '../components/DropdownMenu.js';
import { LoadingState } from '../components/LoadingState.js';
import { RecipeCoverImageEditor } from '../components/RecipeCoverImageEditor.js';
import { RecipeScanDialog } from '../components/RecipeScanDialog.js';
import { CookingHistoryPanel } from '../cooking/CookingHistoryPanel.js';
import { CookingPanel } from '../cooking/CookingPanel.js';
import { useRecordRecipeView } from '../cooking/queries.js';
import { TagEditor } from '../cooking/TagEditor.js';
import {
  toDomainRule,
  useGlobalConversionRules,
  useHouseConversionRules,
} from '../data/conversions.js';
import {
  useAdaptations,
  useCollectionMeta,
  useDeleteRecipe,
  useRecipe,
  useRecipeSummary,
  useSaveRecipe,
} from '../data/queries.js';
import { useMyHousehold } from '../household/queries.js';
import {
  cancelRewrite,
  getUserRewritePrefs,
  kickRewrite,
  OcrWorkerNotConfiguredError,
  startRewrite,
} from '../import/api.js';
import { useImportItemsForRecipe } from '../import/queries.js';
import { RecipeNutritionPanel } from '../nutrition/RecipeNutritionPanel.js';
import { RecipeContentGrid, RecipeHeaderMeta } from '../recipe/RecipeBody.js';
import { RemixDialog } from '../recipe/RemixDialog.js';
import { usePinchTextScale } from '../recipe/usePinchTextScale.js';
import {
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  useRecipeTextScale,
} from '../recipe/useRecipeTextScale.js';
import { useRewriteJob } from '../recipe/useRewriteJob.js';
import {
  DEFAULT_REWRITE_MODEL_BY_PROVIDER,
  DEFAULT_REWRITE_PROMPT,
} from '../settings/rewriteSettings.js';
import { shareRecipe } from '../share/share.js';
import { shareAudience } from '../share/shareAudience.js';
import { ShareLinkButton } from '../share/ShareLinkButton.js';
export function RecipePage() {
  const { collectionId, recipeId } = useParams();
  const navigate = useNavigate();
  // Collection metadata + the one recipe — not the whole collection graph.
  // Hydrating every recipe just to find this one made opening a recipe in a
  // 500-recipe cookbook pay for all 500.
  const { data: collection, isLoading: collectionLoading } = useCollectionMeta(collectionId);
  const { data: recipe, isLoading: recipeLoading } = useRecipe(collectionId, recipeId);
  const isLoading = collectionLoading || recipeLoading;

  // Local-only browsing history: record one view per recipe id the page
  // settles on. Fire-and-forget; guarded so re-renders don't double-log.
  const recordView = useRecordRecipeView();
  const recordViewMutate = recordView.mutate;
  useEffect(() => {
    if (recipeId) recordViewMutate({ recipeId, source: 'recipe_page' });
  }, [recipeId, recordViewMutate]);
  const deleteRecipe = useDeleteRecipe(collectionId ?? '');
  const saveRecipe = useSaveRecipe(collectionId ?? '');
  const { data: parent } = useRecipeSummary(recipe?.parentRecipeId);
  const { data: adaptations = [] } = useAdaptations(recipe?.id);

  const [scale, setScale] = useState(1);
  const [targetUnit, setTargetUnit] = useState<string>('');
  const textScale = useRecipeTextScale();
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Native-only: two-finger pinch on the recipe body adjusts the text size.
  // Read the live value through a ref so the gesture listeners (which bind
  // once) never re-attach mid-pinch.
  const textScaleRef = useRef(textScale.scale);
  textScaleRef.current = textScale.scale;
  const getTextScale = useMemo(() => () => textScaleRef.current, []);
  usePinchTextScale(contentRef, getTextScale, textScale.setScale);
  const [rewriteError, setRewriteError] = useState<string | undefined>();
  const [showScan, setShowScan] = useState(false);
  const [showRemix, setShowRemix] = useState(false);
  const { job: rewriteJob, refresh: refreshRewriteJob } = useRewriteJob(recipeId);
  // While the local-DB query is still loading, fall back to the
  // start-state to keep the toolbar from flickering.
  const rewriteInFlight = rewriteJob?.status === 'PENDING' || rewriteJob?.status === 'CLAIMED';
  const rewriteFailed =
    rewriteJob?.status === 'FAILED' && (rewriteJob.lastError ?? '') !== 'CANCELLED';
  const { data: importItems = [] } = useImportItemsForRecipe(recipeId);
  // Household library-sharing state — tells the share button who can open
  // the link when the collection isn't public.
  const { data: household } = useMyHousehold();

  async function startImprove() {
    setRewriteError(undefined);
    if (!recipe) return;
    try {
      const prefs = await getUserRewritePrefs().catch(() => null);
      const provider = prefs?.provider ?? 'gemini';
      await startRewrite({
        recipeId: recipe.id,
        provider,
        model: prefs?.model || DEFAULT_REWRITE_MODEL_BY_PROVIDER[provider],
        prompt: prefs?.prompt || DEFAULT_REWRITE_PROMPT,
      });
      // Best-effort kick — the cron tick also drains the queue within 30s.
      try {
        await kickRewrite(recipe.id);
      } catch (err) {
        if (err instanceof OcrWorkerNotConfiguredError) {
          setRewriteError(err.message);
        } else {
          // Non-fatal: the job is queued, cron will pick it up.
        }
      }
      await refreshRewriteJob();
    } catch (err) {
      setRewriteError((err as Error).message);
    }
  }

  async function cancelImprove() {
    if (!rewriteJob) return;
    try {
      await cancelRewrite(rewriteJob.id);
      await refreshRewriteJob();
    } catch (err) {
      setRewriteError((err as Error).message);
    }
  }

  const { data: houseRules = [] } = useHouseConversionRules();
  const { data: globalRules = [] } = useGlobalConversionRules();
  const registry = useMemo(
    () =>
      createRegistry([
        ...houseRules.map(toDomainRule('HOUSE')),
        ...globalRules.map(toDomainRule('GLOBAL')),
        ...StandardConversions,
      ]),
    [houseRules, globalRules],
  );
  const scaled = useMemo(() => (recipe ? scaleRecipe(recipe, scale) : undefined), [recipe, scale]);

  if (isLoading) return <LoadingState surface="recipe" />;
  if (!collection || !recipe || !scaled) {
    return <p className="text-stone-600 dark:text-stone-400">Recipe not found.</p>;
  }

  function displayQuantity(q: Quantity, ingredientName: string): string {
    if (!targetUnit || targetUnit === q.unit) return formatQuantity(q);
    const factor = registry.findFactor(q.unit, targetUnit, ingredientName);
    if (factor === undefined) return formatQuantity(q);
    const n = quantityValue(q);
    return formatQuantity(exact(n * factor, targetUnit));
  }

  async function shareAsMarkdown() {
    const md = recipeToMarkdown(scaled!);
    // shareRecipe picks the right surface: native share sheet on device,
    // Web Share API where supported, Markdown download on desktop browsers.
    await shareRecipe({ title: recipe!.title, markdown: md });
  }

  async function adaptThisRecipe() {
    const clone = adaptRecipe(recipe!);
    // mutateAsync resolves after the local write lands, and the editor
    // fetches the clone itself via `useRecipe` (a fresh key — nothing
    // stale to refetch), so navigating immediately is safe.
    await saveRecipe.mutateAsync(clone);
    navigate(`/collections/${collection!.id}/recipes/${clone.id}/edit`);
  }

  async function toggleStar() {
    if (!recipe) return;
    await saveRecipe.mutateAsync({ ...recipe, starred: !(recipe.starred === true) });
  }

  async function setCover(path: string | undefined) {
    if (!recipe) return;
    await saveRecipe.mutateAsync({ ...recipe, coverImagePath: path });
  }

  return (
    <div className="space-y-6 overflow-x-clip">
      {showScan && <RecipeScanDialog items={importItems} onClose={() => setShowScan(false)} />}
      {showRemix && (
        <RemixDialog
          recipe={recipe}
          collectionId={collection.id}
          onClose={() => setShowRemix(false)}
          onSaved={(newRecipeId, destCollectionId) => {
            setShowRemix(false);
            navigate(`/collections/${destCollectionId}/recipes/${newRecipeId}`);
          }}
        />
      )}
      <div>
        <Link
          to={`/collections/${collection.id}`}
          className="text-sm text-stone-600 dark:text-stone-400 hover:underline"
        >
          ← {collection.title}
        </Link>
        <RecipeHeaderMeta
          recipe={scaled}
          collection={collection}
          isAdaptation={!!parent}
          coverSlot={<RecipeCoverImageEditor recipe={recipe} onChange={setCover} />}
          collectionHref={`/collections/${collection.id}`}
        >
          {importItems.length > 0 && (
            <button
              type="button"
              onClick={() => setShowScan(true)}
              className="mt-1 text-sm text-stone-600 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
              title="See the original photo(s) that this recipe was imported from"
            >
              📷 View original scan ({importItems.length} page
              {importItems.length === 1 ? '' : 's'})
            </button>
          )}
          {parent && (
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Adapted from{' '}
              <Link
                to={`/collections/${parent.collectionId}/recipes/${parent.id}`}
                className="underline hover:text-stone-900 dark:hover:text-stone-100"
              >
                {parent.title}
              </Link>
            </p>
          )}
        </RecipeHeaderMeta>

        <TagEditor recipeId={recipe.id} />
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-stone-600 dark:text-stone-400">Scale</span>
          <input
            type="number"
            min={0.25}
            step={0.25}
            value={scale}
            onChange={(e) => setScale(Math.max(0.25, Number(e.target.value) || 1))}
            className="w-20 rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
          />
          <span className="text-stone-500 dark:text-stone-400">×</span>
        </label>
        <div className="flex items-center gap-2 text-sm">
          {[0.5, 1, 2, 3].map((v) => (
            <button
              key={v}
              onClick={() => setScale(v)}
              className={`rounded px-2 py-1 ${
                scale === v ? 'bg-stone-900 text-white' : 'hover:bg-stone-100'
              }`}
            >
              {v}×
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-stone-600 dark:text-stone-400">Convert to</span>
          <select
            value={targetUnit}
            onChange={(e) => setTargetUnit(e.target.value)}
            className="rounded border border-stone-300 dark:border-stone-600 px-2 py-1"
          >
            <option value="">original units</option>
            {Object.values(Units).map((u) => (
              <option key={u.name} value={u.name}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <div role="group" aria-label="Text size" className="flex items-center gap-1 text-sm">
          <button
            type="button"
            onClick={textScale.decrease}
            disabled={textScale.scale <= TEXT_SCALE_MIN}
            aria-label="Decrease text size"
            className="flex h-9 min-w-9 items-center justify-center rounded border border-stone-300 px-2 text-xs hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:hover:bg-stone-800"
          >
            A−
          </button>
          <button
            type="button"
            onClick={textScale.increase}
            disabled={textScale.scale >= TEXT_SCALE_MAX}
            aria-label="Increase text size"
            data-testid="text-size-increase"
            className="flex h-9 min-w-9 items-center justify-center rounded border border-stone-300 px-2 text-base hover:bg-stone-100 disabled:opacity-40 dark:border-stone-600 dark:hover:bg-stone-800"
          >
            A+
          </button>
          {textScale.scale !== 1 && (
            <button
              type="button"
              onClick={textScale.reset}
              aria-label="Reset text size"
              className="rounded px-1.5 py-1 text-xs text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
            >
              Reset
            </button>
          )}
        </div>
        <div className="ml-auto flex gap-2">
          <Link
            to={`/collections/${collection.id}/recipes/${recipe.id}/cook`}
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
          >
            Cook mode
          </Link>
          <Link
            to={`/collections/${collection.id}/recipes/${recipe.id}/edit`}
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Edit
          </Link>
          <ShareLinkButton
            recipeId={recipe.id}
            audience={shareAudience({
              isPublic: collection.isPublic,
              takenDown: collection.moderationState === 'TAKEN_DOWN',
              libraryShared: !!household?.libraryShared,
            })}
          />
          {/* In-flight rewrite stays visible as a toolbar chip — the menu
              closes after starting, so the status (and cancel) can't live
              only inside it. */}
          {rewriteInFlight && (
            <button
              type="button"
              onClick={cancelImprove}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
              data-testid="rewrite-status"
              title="Cancel rewrite"
            >
              Rewriting…
            </button>
          )}
          <DropdownMenu label="More actions" testId="recipe-more-menu">
            {(close) => (
              <>
                {!rewriteInFlight && (
                  <DropdownMenuItem
                    testId={rewriteFailed ? 'rewrite-retry' : 'improve-instructions'}
                    title={rewriteFailed ? (rewriteJob?.lastError ?? 'Rewrite failed') : undefined}
                    onSelect={() => {
                      close();
                      void startImprove();
                    }}
                  >
                    {rewriteFailed ? 'Retry rewrite' : 'Improve instructions'}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={saveRecipe.isPending}
                  onSelect={() => {
                    close();
                    void adaptThisRecipe();
                  }}
                >
                  Adapt
                </DropdownMenuItem>
                <DropdownMenuItem
                  testId="remix-open"
                  onSelect={() => {
                    close();
                    setShowRemix(true);
                  }}
                >
                  Remix
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={saveRecipe.isPending}
                  title={
                    recipe.starred === true
                      ? 'Unstar (remove from Speed Importer queue)'
                      : 'Star this recipe so the Speed Importer queues it for scanning'
                  }
                  onSelect={() => {
                    close();
                    void toggleStar();
                  }}
                >
                  <span
                    aria-hidden
                    className={recipe.starred === true ? 'text-amber-600 dark:text-amber-400' : ''}
                  >
                    {recipe.starred === true ? '★' : '☆'}
                  </span>{' '}
                  {recipe.starred === true ? 'Starred' : 'Star'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  title="Export this recipe as Markdown / via the share sheet"
                  onSelect={() => {
                    close();
                    void shareAsMarkdown();
                  }}
                >
                  Export
                </DropdownMenuItem>
                <DropdownMenuItem
                  tone="danger"
                  onSelect={async () => {
                    // Close before confirm() — the native dialog would
                    // otherwise race the menu's outside-click handler.
                    close();
                    if (confirm(`Delete "${recipe.title}"?`)) {
                      await deleteRecipe.mutateAsync(recipe.id);
                      navigate(`/collections/${collection.id}`);
                    }
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenu>
        </div>
      </div>

      {rewriteError && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
        >
          {rewriteError}
        </div>
      )}

      <div ref={contentRef}>
        <RecipeContentGrid
          recipe={scaled}
          displayQuantity={displayQuantity}
          textScale={textScale.scale}
        />
      </div>

      <CookingPanel recipe={recipe} />

      <CookingHistoryPanel recipe={recipe} />

      <RecipeNutritionPanel recipe={recipe} />

      {adaptations.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Adaptations ({adaptations.length})</h2>
          <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
            {adaptations.map((a) => (
              <li key={a.id}>
                <Link
                  to={`/collections/${a.collectionId}/recipes/${a.id}`}
                  className="block px-4 py-2 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-900"
                >
                  {a.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function quantityValue(q: Quantity): number {
  switch (q.type) {
    case 'EXACT':
      return q.amount;
    case 'FRACTIONAL':
      return q.whole + q.numerator / q.denominator;
    case 'RANGE':
      return (q.min + q.max) / 2;
  }
}
