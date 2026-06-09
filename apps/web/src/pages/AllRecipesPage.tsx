import { useDeferredValue, useMemo, useState } from 'react';
import { useGalleryRecipes } from '../data/queries.js';
import { useSync } from '../local/SyncProvider.js';
import { RecipeGalleryGrid } from '../components/RecipeGalleryGrid.js';
import { sortByLastMade } from '../components/SortableRecipeList.js';
import { EmptyMadeHint } from '../components/EmptyMadeHint.js';
import { usePersistedState } from '../components/usePersistedState.js';
import { LoadingState } from '../components/LoadingState.js';
import { useLastMadeByRecipe } from '../cooking/queries.js';

/** `views` is the query's native order (view count, then last viewed). */
type GallerySortMode = 'views' | 'name' | 'made';

function isGallerySortMode(v: string): v is GallerySortMode {
  return v === 'views' || v === 'name' || v === 'made';
}

/**
 * Library-wide cover gallery: every non-empty recipe you can see (your own +
 * household-shared), default-sorted by how often / how recently you've opened
 * each one (see {@link useGalleryRecipes}). The search box filters instantly,
 * client-side, by recipe title OR owning book (collection title / author) —
 * "search by recipe or by book". The query already returns view-sorted rows,
 * so the filtered list keeps that order.
 */
export function AllRecipesPage() {
  const { localReady, hydrated, status } = useSync();
  const { data: recipes = [], isLoading, error } = useGalleryRecipes();
  const [sortMode, setSortMode] = usePersistedState<GallerySortMode>(
    'cookyourbooks.sort.recipes.v1',
    'views',
    isGallerySortMode,
  );
  const lastMade = useLastMadeByRecipe().data;

  const [filterQuery, setFilterQuery] = useState('');
  // Defer the query so typing stays snappy on large libraries; the input is
  // bound to the immediate value so the field itself never lags.
  const deferredQuery = useDeferredValue(filterQuery);
  const q = deferredQuery.trim().toLowerCase();
  const isFiltering = q !== '';

  const filtered = useMemo(() => {
    if (!isFiltering) return recipes;
    return recipes.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.collectionTitle.toLowerCase().includes(q) ||
        (r.collectionAuthor?.toLowerCase().includes(q) ?? false),
    );
  }, [recipes, q, isFiltering]);

  // 'views' keeps the query's native order; the other modes re-sort in JS.
  const sorted = useMemo(() => {
    if (sortMode === 'made') return sortByLastMade(filtered, lastMade);
    if (sortMode === 'name') {
      return [...filtered].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
    }
    return filtered;
  }, [filtered, sortMode, lastMade]);

  const waitingForData = isLoading && recipes.length === 0;
  const awaitingFirstSync =
    recipes.length === 0 && (!hydrated || status === 'syncing' || status === 'initializing');

  if (!localReady || waitingForData) return <LoadingState surface="all-recipes" />;
  if (error) return <p className="text-red-700 dark:text-red-300">{(error as Error).message}</p>;

  const countLabel = `${recipes.length} ${recipes.length === 1 ? 'recipe' : 'recipes'}`;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Recipes</h1>

      {recipes.length === 0 ? (
        awaitingFirstSync ? (
          // Not truly empty — the first pull just hasn't landed yet. Show the
          // loading treatment instead of an empty-looking page.
          <LoadingState
            surface="all-recipes"
            hints={['No data cached on this device yet — pulling your recipes…']}
          />
        ) : (
          <p className="text-stone-600 dark:text-stone-400">
            No recipes yet. Add or import some to start your gallery.
          </p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search recipes or cookbooks…"
              aria-label="Search recipes or cookbooks"
              className="min-w-0 flex-1 rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
            />
            <label htmlFor="gallery-sort" className="sr-only">
              Sort
            </label>
            <select
              id="gallery-sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as GallerySortMode)}
              className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-sm"
            >
              <option value="views">Most viewed</option>
              <option value="name">Name (A–Z)</option>
              <option value="made">Recently made</option>
            </select>
          </div>
          <div className="text-xs text-stone-400 dark:text-stone-500">
            {isFiltering ? `${filtered.length} of ${countLabel}` : countLabel}
          </div>
          {sortMode === 'made' && (lastMade?.size ?? 0) === 0 && <EmptyMadeHint />}
          {filtered.length === 0 ? (
            <p className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
              No recipes match “{filterQuery.trim()}”.
            </p>
          ) : (
            <RecipeGalleryGrid items={sorted} />
          )}
        </>
      )}
    </div>
  );
}
