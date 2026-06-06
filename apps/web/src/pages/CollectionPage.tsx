import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Cookbook, RecipeCollection } from '@cookyourbooks/domain';
import {
  useCollection,
  useDeleteCollection,
  useReorderRecipes,
  useSaveCollection,
  useSaveRecipe,
} from '../data/queries.js';
import { CoverImageEditor } from '../components/CoverImageEditor.js';
import { ImportFromPhoto } from '../import/ImportFromPhoto.js';
import { SortableRecipeList, type RecipeSortMode } from '../components/SortableRecipeList.js';
import { CopyLinkButton } from '../share/CopyLinkButton.js';
import { collectionShareUrl } from '../share/shareUrl.js';
import { ShareToGlobalButton } from '../components/ShareToGlobalButton.js';
import { MakePublicDialog } from '../components/MakePublicDialog.js';
import { CollectionShareSection } from '../household/CollectionShareSection.js';
import { useAuth } from '../auth/AuthProvider.js';
import { findOpenPlannerSession } from '../import/localRepos.js';
export function CollectionPage() {
  const { collectionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: collection, isLoading, error } = useCollection(collectionId);
  const deleteCollection = useDeleteCollection();
  const saveCollection = useSaveCollection();
  const reorderRecipes = useReorderRecipes(collectionId ?? '');
  const saveRecipe = useSaveRecipe(collectionId ?? '');
  const [showPublishWarning, setShowPublishWarning] = useState(false);
  const [hasOpenSession, setHasOpenSession] = useState(false);
  const [sortMode, setSortMode] = useState<RecipeSortMode>('manual');

  // Cheap one-shot probe so the CTA can say "resume" when applicable.
  // Re-runs whenever the collection's recipe list changes (which is also
  // when the user might have started a session and come back).
  useEffect(() => {
    if (!user || !collection || collection.sourceType !== 'PUBLISHED_BOOK') {
      setHasOpenSession(false);
      return;
    }
    let cancelled = false;
    void findOpenPlannerSession(user.id, collection.id).then((s) => {
      if (!cancelled) setHasOpenSession(!!s);
    });
    return () => {
      cancelled = true;
    };
  }, [user, collection]);

  if (isLoading) return <p className="text-stone-500 dark:text-stone-400">Loading…</p>;
  if (error) return <p className="text-red-700 dark:text-red-300">{(error as Error).message}</p>;
  if (!collection) return <p className="text-stone-600 dark:text-stone-400">Collection not found.</p>;

  const c = collection;
  // Hard rule mirrored at the DB layer: a PUBLISHED_BOOK with an ISBN
  // contains copyrighted material and can never be public.
  const isbnBlocksPublic =
    c.sourceType === 'PUBLISHED_BOOK' &&
    !!(c as Cookbook).isbn &&
    (c as Cookbook).isbn!.trim() !== '';

  function onPublicClick() {
    if (c.isPublic) {
      void togglePublic();
    } else {
      // First-time publish goes through the DMCA / zero-tolerance dialog.
      setShowPublishWarning(true);
    }
  }

  async function togglePublic() {
    setShowPublishWarning(false);
    await saveCollection.mutateAsync({ ...c, isPublic: !c.isPublic } as RecipeCollection);
  }

  async function onCoverChange(newPath: string | undefined) {
    await saveCollection.mutateAsync({ ...c, coverImagePath: newPath } as RecipeCollection);
  }

  async function onToggleStar(recipeId: string) {
    const recipe = c.recipes.find((r) => r.id === recipeId);
    if (!recipe) return;
    await saveRecipe.mutateAsync({ ...recipe, starred: !(recipe.starred === true) });
  }

  const starredCount = c.recipes.filter((r) => r.starred === true).length;
  const starredPlaceholderCount = c.recipes.filter(
    (r) =>
      r.starred === true &&
      r.ingredients.length === 0 &&
      r.instructions.length === 0,
  ).length;
  const showSpeedImporterCta =
    c.sourceType === 'PUBLISHED_BOOK' && (starredPlaceholderCount > 0 || hasOpenSession);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">{subtitle(c)}</div>
        <h1 className="mt-1 text-2xl font-semibold">{c.title}</h1>
        {c.sourceType === 'PERSONAL' && c.description && (
          <p className="mt-2 text-stone-600 dark:text-stone-400">{c.description}</p>
        )}
      </div>

      {c.moderationState === 'TAKEN_DOWN' && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200"
        >
          <div className="font-medium">This collection was taken down by a moderator.</div>
          {c.moderationReason && (
            <div className="mt-1">
              Reason: <span className="italic">{c.moderationReason}</span>
            </div>
          )}
          <div className="mt-2 text-amber-800 dark:text-amber-300">
            It is not visible on Discover and cannot be re-published without moderator review.
            Your local recipes and edits are untouched.
          </div>
        </div>
      )}

      <CoverImageEditor collection={c} onChange={onCoverChange} />

      <div className="flex flex-wrap items-center gap-3">
        <Link
          to={`/collections/${c.id}/recipes/new`}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          Add recipe
        </Link>
        <ImportFromPhoto collectionId={c.id} />
        <button
          onClick={onPublicClick}
          disabled={
            saveCollection.isPending ||
            c.moderationState === 'TAKEN_DOWN' ||
            (isbnBlocksPublic && !c.isPublic)
          }
          title={
            c.moderationState === 'TAKEN_DOWN'
              ? 'Taken down by a moderator'
              : isbnBlocksPublic && !c.isPublic
                ? "Cookbooks with an ISBN can't be made public — those recipes belong to the publisher. See /legal/dmca to report a violation."
                : undefined
          }
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
        >
          {c.isPublic ? 'Make private' : 'Make public'}
        </button>
        {c.isPublic && c.moderationState !== 'TAKEN_DOWN' && (
          <CopyLinkButton
            url={collectionShareUrl(c.id)}
            className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
          />
        )}
        {c.sourceType === 'PUBLISHED_BOOK' && c.moderationState !== 'TAKEN_DOWN' && (
          <ShareToGlobalButton cookbook={c} />
        )}
        {c.moderationState !== 'TAKEN_DOWN' && (
          <CollectionShareSection />
        )}
        <button
          onClick={async () => {
            if (confirm(`Delete "${c.title}" and all its recipes?`)) {
              await deleteCollection.mutateAsync(c.id);
              navigate('/');
            }
          }}
          className="rounded-md px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
        >
          Delete collection
        </button>
      </div>

      {showSpeedImporterCta && (
        <Link
          to={`/import/speed?collection=${c.id}`}
          className="flex items-center justify-between rounded-lg border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 px-4 py-3 text-sm hover:bg-indigo-100 dark:hover:bg-indigo-900/60"
        >
          <span className="flex items-center gap-2 text-indigo-900 dark:text-indigo-200">
            <span aria-hidden className="text-base">★</span>
            <span>
              <strong>Speed Importer</strong>
              {starredCount > 0 && (
                <>
                  {' '}
                  · {starredCount} starred
                  {starredPlaceholderCount > 0 &&
                    starredPlaceholderCount !== starredCount &&
                    ` (${starredPlaceholderCount} to scan)`}
                </>
              )}
              {hasOpenSession && ' · resume'}
            </span>
          </span>
          <span className="text-indigo-700 dark:text-indigo-300">→</span>
        </Link>
      )}

      {c.recipes.length === 0 ? (
        <p className="text-stone-600 dark:text-stone-400">No recipes yet.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-end gap-2 text-sm">
            <label htmlFor="recipe-sort" className="text-stone-500 dark:text-stone-400">
              Sort
            </label>
            <select
              id="recipe-sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as RecipeSortMode)}
              className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-sm"
            >
              <option value="manual">Manual order</option>
              <option value="name">Name (A–Z)</option>
              <option value="page">Page number</option>
            </select>
          </div>
          {sortMode !== 'manual' && (
            <p className="text-right text-xs text-stone-400 dark:text-stone-500">
              Drag-to-reorder is available in Manual order.
            </p>
          )}
          <SortableRecipeList
            collectionId={c.id}
            recipes={c.recipes}
            onReorder={(ids) => reorderRecipes.mutateAsync(ids)}
            onToggleStar={onToggleStar}
            sortMode={sortMode}
          />
        </div>
      )}
      <MakePublicDialog
        open={showPublishWarning}
        collectionTitle={c.title}
        onCancel={() => setShowPublishWarning(false)}
        onConfirm={() => void togglePublic()}
        isPending={saveCollection.isPending}
      />
    </div>
  );
}

function subtitle(c: RecipeCollection): string {
  switch (c.sourceType) {
    case 'PUBLISHED_BOOK':
      return c.author ? `Cookbook · ${c.author}` : 'Cookbook';
    case 'WEBSITE':
      return c.siteName ? `Web · ${c.siteName}` : 'Web';
    case 'PERSONAL':
      return 'Personal';
  }
}
