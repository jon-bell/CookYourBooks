import { useDeferredValue, useMemo, useState } from 'react';
import { useGalleryRecipes } from '../data/queries.js';
import { useSync } from '../local/SyncProvider.js';
import { RecipeGalleryGrid } from '../components/RecipeGalleryGrid.js';

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

  const waitingForData = isLoading && recipes.length === 0;
  const awaitingFirstSync =
    recipes.length === 0 && (!hydrated || status === 'syncing' || status === 'initializing');

  if (!localReady || waitingForData)
    return <p className="text-stone-500 dark:text-stone-400">Loading…</p>;
  if (error) return <p className="text-red-700 dark:text-red-300">{(error as Error).message}</p>;

  const countLabel = `${recipes.length} ${recipes.length === 1 ? 'recipe' : 'recipes'}`;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Recipes</h1>

      {recipes.length === 0 ? (
        awaitingFirstSync ? (
          <p className="text-stone-600 dark:text-stone-400">
            No data locally cached, refreshing from server…
          </p>
        ) : (
          <p className="text-stone-600 dark:text-stone-400">
            No recipes yet. Add or import some to start your gallery.
          </p>
        )
      ) : (
        <>
          <input
            type="search"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Search recipes or cookbooks…"
            aria-label="Search recipes or cookbooks"
            className="w-full rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
          />
          <div className="text-xs text-stone-400 dark:text-stone-500">
            {isFiltering ? `${filtered.length} of ${countLabel}` : countLabel}
          </div>
          {filtered.length === 0 ? (
            <p className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
              No recipes match “{filterQuery.trim()}”.
            </p>
          ) : (
            <RecipeGalleryGrid items={filtered} />
          )}
        </>
      )}
    </div>
  );
}
