import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  adaptRecipe,
  createRegistry,
  formatQuantity,
  formatServings,
  isMeasured,
  recipeToMarkdown,
  scaleRecipe,
  StandardConversions,
  Units,
  type Quantity,
  exact,
} from '@cookyourbooks/domain';
import {
  useAdaptations,
  useCollectionMeta,
  useDeleteRecipe,
  useRecipe,
  useRecipeSummary,
  useSaveRecipe,
} from '../data/queries.js';
import {
  toDomainRule,
  useGlobalConversionRules,
  useHouseConversionRules,
} from '../data/conversions.js';
import { shareRecipe } from '../share/share.js';
import { CopyLinkButton } from '../share/CopyLinkButton.js';
import { recipeShareUrl } from '../share/shareUrl.js';
import { useRewriteJob } from '../recipe/useRewriteJob.js';
import { RemixDialog } from '../recipe/RemixDialog.js';
import {
  cancelRewrite,
  getUserRewritePrefs,
  kickRewrite,
  OcrWorkerNotConfiguredError,
  startRewrite,
} from '../import/api.js';
import {
  DEFAULT_REWRITE_MODEL_BY_PROVIDER,
  DEFAULT_REWRITE_PROMPT,
} from '../settings/rewriteSettings.js';
import { useImportItemsForRecipe } from '../import/queries.js';
import { RecipeScanDialog } from '../components/RecipeScanDialog.js';
import { CoverImage } from '../components/CoverImage.js';
import { RecipeCoverImageEditor } from '../components/RecipeCoverImageEditor.js';
import { RecipeNutritionPanel } from '../nutrition/RecipeNutritionPanel.js';
import { CookingPanel } from '../cooking/CookingPanel.js';
import { CookingHistoryPanel } from '../cooking/CookingHistoryPanel.js';
import { TagEditor } from '../cooking/TagEditor.js';
import { useRecordRecipeView } from '../cooking/queries.js';
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
  const [rewriteError, setRewriteError] = useState<string | undefined>();
  const [showScan, setShowScan] = useState(false);
  const [showRemix, setShowRemix] = useState(false);
  const { job: rewriteJob, refresh: refreshRewriteJob } = useRewriteJob(recipeId);
  const { data: importItems = [] } = useImportItemsForRecipe(recipeId);

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

  if (isLoading) return <p className="text-stone-500 dark:text-stone-400">Loading…</p>;
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
    <div className="space-y-6">
      {showScan && (
        <RecipeScanDialog items={importItems} onClose={() => setShowScan(false)} />
      )}
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
        <Link to={`/collections/${collection.id}`} className="text-sm text-stone-600 dark:text-stone-400 hover:underline">
          ← {collection.title}
        </Link>
        {recipe.coverImagePath && (
          <CoverImage
            path={recipe.coverImagePath}
            alt={`${recipe.title} cover`}
            className="mt-3 h-48 w-full max-w-md rounded-lg border border-stone-200 dark:border-stone-700"
          />
        )}
        <h1 className="mt-1 text-3xl font-semibold">{recipe.title}</h1>
        {collection.sourceType === 'PUBLISHED_BOOK' && collection.author && (
          <p className="mt-1 text-base text-stone-600 dark:text-stone-400">
            by{' '}
            <span className="font-medium text-stone-900 dark:text-stone-100">
              {collection.author}
            </span>
          </p>
        )}
        {collection.sourceType === 'WEBSITE' && collection.siteName && (
          <p className="mt-1 text-base text-stone-600 dark:text-stone-400">
            from{' '}
            <span className="font-medium text-stone-900 dark:text-stone-100">
              {collection.siteName}
            </span>
          </p>
        )}
        {(recipe.bookTitle || (recipe.pageNumbers && recipe.pageNumbers.length > 0)) && (
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            {recipe.bookTitle}
            {recipe.bookTitle && recipe.pageNumbers && recipe.pageNumbers.length > 0 ? ' · ' : ''}
            {recipe.pageNumbers && recipe.pageNumbers.length > 0
              ? `p. ${recipe.pageNumbers.join(', ')}`
              : ''}
          </p>
        )}
        {recipe.sourceUrl && (
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            <a
              href={recipe.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:underline"
            >
              ▶ Watch the source video
            </a>
          </p>
        )}
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
        {scaled.servings && (
          <p className="mt-1 text-stone-600 dark:text-stone-400">Serves {formatServings(scaled.servings)}</p>
        )}
        {recipe.timeEstimate && (
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">⏲ {recipe.timeEstimate}</p>
        )}
        {recipe.description && (
          <figure className="mt-4 border-l-2 border-stone-300 dark:border-stone-600 pl-3">
            {!parent && collection.sourceType === 'PUBLISHED_BOOK' && (
              <figcaption className="text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Headnote{collection.author ? ` from ${collection.author}` : ' from the original recipe'}
              </figcaption>
            )}
            {!parent && collection.sourceType === 'WEBSITE' && (
              <figcaption className="text-[11px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                From {collection.siteName ?? 'the original source'}
              </figcaption>
            )}
            <blockquote className="whitespace-pre-wrap text-stone-700 dark:text-stone-300 italic">
              {recipe.description}
            </blockquote>
          </figure>
        )}
        {recipe.equipment && recipe.equipment.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5 text-xs">
            {recipe.equipment.map((item) => (
              <li
                key={item}
                className="rounded-full bg-stone-100 dark:bg-stone-800 px-2 py-0.5 text-stone-700 dark:text-stone-300"
              >
                {item}
              </li>
            ))}
          </ul>
        )}

        <TagEditor recipeId={recipe.id} />

        <div className="mt-4">
          <RecipeCoverImageEditor recipe={recipe} onChange={setCover} />
        </div>
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
        <div className="ml-auto flex gap-2">
          <Link
            to={`/collections/${collection.id}/recipes/${recipe.id}/cook`}
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
          >
            Cook mode
          </Link>
          <ImproveInstructionsButton
            job={rewriteJob}
            onStart={startImprove}
            onCancel={cancelImprove}
          />
          <Link
            to={`/collections/${collection.id}/recipes/${recipe.id}/edit`}
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Edit
          </Link>
          <button
            onClick={adaptThisRecipe}
            disabled={saveRecipe.isPending}
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
          >
            Adapt
          </button>
          <button
            onClick={() => setShowRemix(true)}
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
            data-testid="remix-open"
          >
            Remix
          </button>
          <button
            type="button"
            onClick={toggleStar}
            disabled={saveRecipe.isPending}
            aria-pressed={recipe.starred === true}
            title={
              recipe.starred === true
                ? 'Unstar (remove from Speed Importer queue)'
                : 'Star this recipe so the Speed Importer queues it for scanning'
            }
            className={`rounded-md px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 ${
              recipe.starred === true
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-stone-700 dark:text-stone-300'
            }`}
          >
            <span aria-hidden>{recipe.starred === true ? '★' : '☆'}</span>{' '}
            {recipe.starred === true ? 'Starred' : 'Star'}
          </button>
          <button
            onClick={shareAsMarkdown}
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600"
          >
            Share
          </button>
          {collection.isPublic && collection.moderationState !== 'TAKEN_DOWN' && (
            <CopyLinkButton url={recipeShareUrl(collection.id, recipe.id)} />
          )}
          <button
            onClick={async () => {
              if (confirm(`Delete "${recipe.title}"?`)) {
                await deleteRecipe.mutateAsync(recipe.id);
                navigate(`/collections/${collection.id}`);
              }
            }}
            className="rounded-md px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            Delete
          </button>
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

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <section className="md:col-span-1 space-y-2">
          <h2 className="text-lg font-semibold">Ingredients</h2>
          <ul className="space-y-1.5" data-testid="ingredient-list">
            {scaled.ingredients.map((ing) => (
              <li key={ing.id} className="text-sm">
                {isMeasured(ing) ? (
                  <>
                    <span className="font-medium">
                      {displayQuantity(ing.quantity, ing.name)}
                    </span>{' '}
                    {ing.name}
                    {ing.preparation && (
                      <span className="text-stone-500 dark:text-stone-400">, {ing.preparation}</span>
                    )}
                  </>
                ) : (
                  <>
                    {ing.name}
                    {ing.preparation && (
                      <span className="text-stone-500 dark:text-stone-400">, {ing.preparation}</span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="md:col-span-2 space-y-2">
          <h2 className="text-lg font-semibold">Instructions</h2>
          <ol className="space-y-3">
            {scaled.instructions.map((step) => (
              <li key={step.id} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-900 dark:bg-stone-100 text-xs font-medium text-white dark:text-stone-900">
                  {step.stepNumber}
                </span>
                <div className="flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span>{step.text}</span>
                    {step.temperature && (
                      <span className="rounded-full bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-xs text-amber-900 dark:text-amber-200 ring-1 ring-amber-200">
                        {step.temperature.value}°
                        {step.temperature.unit === 'FAHRENHEIT' ? 'F' : 'C'}
                      </span>
                    )}
                  </div>
                  {step.subInstructions && step.subInstructions.length > 0 && (
                    <ul className="mt-1 ml-4 list-disc space-y-0.5 text-sm text-stone-600 dark:text-stone-400">
                      {step.subInstructions.map((sub, i) => (
                        <li key={i}>{sub}</li>
                      ))}
                    </ul>
                  )}
                  {step.simplifiedSteps && step.simplifiedSteps.length > 0 && (
                    <details className="mt-2" data-testid="simplified-preview">
                      <summary className="cursor-pointer text-xs text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200">
                        Simplified steps for Cook Mode
                      </summary>
                      <ul className="mt-1 ml-4 list-decimal space-y-0.5 text-sm text-stone-600 dark:text-stone-400">
                        {step.simplifiedSteps.map((ss, i) => (
                          <li key={i}>
                            {ss.text}
                            {ss.durationSec != null && (
                              <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                {formatDuration(ss.durationSec)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {step.notes && (
                    <p className="mt-1 text-xs italic text-stone-500 dark:text-stone-400">{step.notes}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {recipe.notes && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/40 p-4">
          <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Notes</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700 dark:text-stone-300">{recipe.notes}</p>
        </section>
      )}

      <CookingPanel recipe={recipe} />

      <RecipeNutritionPanel recipe={recipe} />

      <CookingHistoryPanel recipe={recipe} />

      {adaptations.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">
            Adaptations ({adaptations.length})
          </h2>
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

function ImproveInstructionsButton(props: {
  job: ReturnType<typeof useRewriteJob>['job'];
  onStart: () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const { job, onStart, onCancel } = props;
  // While the local-DB query is still loading, fall back to the
  // start-state to keep the toolbar from flickering.
  const inFlight = job?.status === 'PENDING' || job?.status === 'CLAIMED';
  const failed = job?.status === 'FAILED' && (job.lastError ?? '') !== 'CANCELLED';

  if (inFlight) {
    return (
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:text-stone-300 dark:hover:bg-stone-800"
        data-testid="rewrite-status"
        title="Cancel rewrite"
      >
        Rewriting…
      </button>
    );
  }
  if (failed) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="rounded-md border border-amber-400 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-50 dark:border-amber-500/60 dark:text-amber-200 dark:hover:bg-amber-950/40"
        data-testid="rewrite-retry"
        title={job?.lastError ?? 'Rewrite failed'}
      >
        Retry rewrite
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onStart}
      className="rounded-md px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
      data-testid="improve-instructions"
    >
      Improve instructions
    </button>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
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

