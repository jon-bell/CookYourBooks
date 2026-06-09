import { useDeferredValue, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Recipe } from '@cookyourbooks/domain';
import {
  SortableRecipeList,
  formatPages,
  sortRecipes,
  type RecipeSortMode,
} from './SortableRecipeList.js';
import { RecipeGalleryGrid } from './RecipeGalleryGrid.js';

/** True if the recipe's title or any ingredient name contains `q`
 *  (the caller passes `q` already trimmed + lowercased). */
function recipeMatches(recipe: Recipe, q: string): boolean {
  if (recipe.title.toLowerCase().includes(q)) return true;
  return recipe.ingredients.some((i) => i.name.toLowerCase().includes(q));
}

/**
 * The browse surface for one collection: a filter box + a Cover/List/Index
 * view toggle + the existing sort control, over the collection's
 * already-hydrated recipes. Filtering is instant and client-side (no DB
 * round-trip) — the parent passes the fully-hydrated list.
 *
 * - Cover view (the default) = an image-forward grid of 3:2 cover cards
 *   (covers first), for browsing by photo. Internal mode key is `'gallery'`.
 * - List view = the rich, drag-reorderable {@link SortableRecipeList}.
 * - Index view = a dense, scannable multi-column title+page list, for
 *   cookbooks with hundreds of recipes.
 *
 * Manual drag-reorder only makes sense for the whole, unfiltered list in
 * List view, so an active filter transparently falls back to name order
 * (which takes SortableRecipeList's read-only branch, so a reorder can never
 * fire on a partial list).
 */
export function CollectionRecipeBrowser({
  collectionId,
  recipes,
  onReorder,
  onToggleStar,
}: {
  collectionId: string;
  recipes: readonly Recipe[];
  onReorder: (orderedIds: string[]) => Promise<void> | void;
  onToggleStar?: (recipeId: string) => Promise<void> | void;
}) {
  const [filterQuery, setFilterQuery] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'index' | 'gallery'>('gallery');
  const [sortMode, setSortMode] = useState<RecipeSortMode>('manual');

  // Defer the query so typing stays snappy on big cookbooks; the input is
  // bound to the immediate value so the field itself never lags.
  const deferredQuery = useDeferredValue(filterQuery);
  const q = deferredQuery.trim().toLowerCase();
  const isFiltering = q !== '';

  const filtered = useMemo(
    () => (isFiltering ? recipes.filter((r) => recipeMatches(r, q)) : recipes),
    [recipes, q, isFiltering],
  );

  // A filtered subset has no contiguous order to persist, so suppress manual
  // drag while filtering (name order is stable + takes the read-only branch).
  const effectiveSortMode: RecipeSortMode =
    isFiltering && sortMode === 'manual' ? 'name' : sortMode;

  const countLabel = `${recipes.length} ${recipes.length === 1 ? 'recipe' : 'recipes'}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="Filter recipes in this cookbook…"
          aria-label="Filter recipes in this collection"
          className="min-w-0 flex-1 rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
        />
        <div
          role="group"
          aria-label="View"
          className="inline-flex overflow-hidden rounded-md border border-stone-300 dark:border-stone-600"
        >
          {(['gallery', 'list', 'index'] as const).map((mode) => {
            const label = mode === 'gallery' ? 'Cover' : mode === 'list' ? 'List' : 'Index';
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                aria-label={`${label} view`}
                onClick={() => setViewMode(mode)}
                className={`px-2.5 py-1.5 text-sm ${
                  viewMode === mode
                    ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                    : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <label htmlFor="recipe-sort" className="sr-only">
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

      <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-stone-400 dark:text-stone-500">
        <span>{isFiltering ? `${filtered.length} of ${countLabel}` : countLabel}</span>
        {viewMode === 'list' && effectiveSortMode !== 'manual' && (
          <span>Drag-to-reorder is available in Manual order with no active filter.</span>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
          No recipes match “{filterQuery.trim()}”.
        </p>
      ) : viewMode === 'gallery' ? (
        <RecipeGallery collectionId={collectionId} recipes={sortRecipes(filtered, sortMode)} />
      ) : viewMode === 'index' ? (
        <RecipeIndex collectionId={collectionId} recipes={sortRecipes(filtered, sortMode)} />
      ) : (
        <SortableRecipeList
          collectionId={collectionId}
          recipes={filtered}
          onReorder={onReorder}
          onToggleStar={onToggleStar}
          sortMode={effectiveSortMode}
        />
      )}
    </div>
  );
}

/** Dense, read-only multi-column index (title + page) for fast scanning. */
function RecipeIndex({
  collectionId,
  recipes,
}: {
  collectionId: string;
  recipes: readonly Recipe[];
}) {
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
      {recipes.map((r) => {
        const isPlaceholder = r.ingredients.length === 0 && r.instructions.length === 0;
        const pages = formatPages(r.pageNumbers);
        return (
          <li key={r.id}>
            <Link
              to={`/collections/${collectionId}/recipes/${r.id}`}
              title={r.title}
              className={`flex items-baseline justify-between gap-2 rounded px-2 py-1 hover:bg-stone-50 dark:hover:bg-stone-900 ${
                isPlaceholder ? 'text-stone-500 dark:text-stone-500' : ''
              }`}
            >
              <span className={`line-clamp-1 ${isPlaceholder ? '' : 'font-medium'}`}>{r.title}</span>
              {pages ? (
                <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">{pages}</span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Image-forward "cover" view: a responsive grid of 3:2 cover cards (the shared
 * {@link RecipeGalleryGrid}). Recipes that have a cover lead (a stable
 * covers-first partition over the already-sorted list), so the wall spotlights
 * real imagery; cover-less recipes fall back to CoverImage's gradient
 * placeholder. Read-only — it never touches SortableRecipeList, so drag-reorder
 * can't fire here.
 */
function RecipeGallery({
  collectionId,
  recipes,
}: {
  collectionId: string;
  recipes: readonly Recipe[];
}) {
  // Covers first, preserving the caller's chosen sort within each group.
  const items = useMemo(
    () =>
      [
        ...recipes.filter((r) => r.coverImagePath),
        ...recipes.filter((r) => !r.coverImagePath),
      ].map((r) => ({
        id: r.id,
        title: r.title,
        coverImagePath: r.coverImagePath,
        pageNumbers: r.pageNumbers,
        collectionId,
      })),
    [recipes, collectionId],
  );
  return <RecipeGalleryGrid items={items} />;
}
