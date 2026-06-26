import { useDeferredValue, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { CoverImage } from '../components/CoverImage.js';
import { EmptyMadeHint } from '../components/EmptyMadeHint.js';
import { LoadingState } from '../components/LoadingState.js';
import { usePersistedState } from '../components/usePersistedState.js';
import { useLibrarySummaries } from '../data/queries.js';
import type { LibraryCollectionSummary } from '../local/repositories.js';
import { useSync } from '../local/SyncProvider.js';

/** `recent` is the query's native order (filled first, then updated_at). */
type LibrarySortMode = 'recent' | 'name' | 'made';

function isLibrarySortMode(v: string): v is LibrarySortMode {
  return v === 'recent' || v === 'name' || v === 'made';
}

export function LibraryPage() {
  const { localReady, hydrated, status } = useSync();
  const { data: collections = [], isLoading, error } = useLibrarySummaries();
  const [sortMode, setSortMode] = usePersistedState<LibrarySortMode>(
    'cookyourbooks.sort.library.v1',
    'recent',
    isLibrarySortMode,
  );

  const [filterQuery, setFilterQuery] = useState('');
  // Defer the query so typing stays snappy; the input stays bound to the
  // immediate value so the field itself never lags.
  const deferredQuery = useDeferredValue(filterQuery);
  const q = deferredQuery.trim().toLowerCase();
  const isFiltering = q !== '';

  const filtered = useMemo(() => {
    if (!isFiltering) return collections;
    return collections.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.author?.toLowerCase().includes(q) ?? false) ||
        (c.siteName?.toLowerCase().includes(q) ?? false),
    );
  }, [collections, q, isFiltering]);

  // 'recent' keeps the query's native order; the other modes re-sort in JS.
  const sorted = useMemo(() => {
    if (sortMode === 'name') {
      return [...filtered].sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );
    }
    if (sortMode === 'made') {
      return [...filtered].sort((a, b) => {
        const da = a.lastMadeAt ?? '';
        const db = b.lastMadeAt ?? '';
        if (da !== db) return da < db ? 1 : -1;
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      });
    }
    return filtered;
  }, [filtered, sortMode]);

  const nothingMade = collections.every((c) => c.lastMadeAt == null);

  const waitingForData = isLoading && collections.length === 0;
  // The first server pull hasn't finished yet. The local cache might
  // be empty simply because we haven't read from the network — show
  // that state explicitly instead of the "no collections yet" empty.
  const awaitingFirstSync =
    collections.length === 0 && (!hydrated || status === 'syncing' || status === 'initializing');

  if (!localReady || waitingForData) return <LoadingState surface="library" />;
  if (error) return <p className="text-red-700 dark:text-red-300">{error.message}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your library</h1>
        <Link
          to="/collections/new"
          className="inline-flex items-center rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          New collection
        </Link>
      </div>
      {collections.length === 0 ? (
        awaitingFirstSync ? (
          // Not truly empty — the first pull just hasn't landed yet. Show the
          // loading treatment instead of an empty-looking page.
          <LoadingState
            surface="library"
            hints={['No data cached on this device yet — pulling your library…']}
          />
        ) : (
          <p className="text-stone-600 dark:text-stone-400">
            No collections yet. Create your first to start adding recipes.
          </p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter by title, author, or site…"
              aria-label="Filter your library"
              className="min-w-0 flex-1 rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-sm"
            />
            <label htmlFor="library-sort" className="sr-only">
              Sort
            </label>
            <select
              id="library-sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as LibrarySortMode)}
              className="rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-2 py-1 text-sm"
            >
              <option value="recent">Recently updated</option>
              <option value="name">Name (A–Z)</option>
              <option value="made">Recently made</option>
            </select>
          </div>
          {sortMode === 'made' && nothingMade && <EmptyMadeHint />}
          {filtered.length === 0 ? (
            <p className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
              No collections match “{filterQuery.trim()}”.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sorted.map((c) => {
                const isPlaceholder = c.filledRecipeCount === 0 && c.recipeCount > 0;
                return (
                  <li
                    key={c.id}
                    className={`overflow-hidden rounded-lg border bg-white dark:bg-stone-900 hover:border-stone-400 ${
                      isPlaceholder
                        ? 'border-stone-200 dark:border-stone-800 opacity-60 hover:opacity-100'
                        : 'border-stone-200 dark:border-stone-700'
                    }`}
                  >
                    <Link to={`/collections/${c.id}`} className="block">
                      <CoverImage
                        path={c.coverImagePath ?? undefined}
                        className="aspect-[3/2] w-full"
                        variant="thumb"
                      />
                      <div className="p-4">
                        <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
                          {collectionSubtitle(c)}
                        </div>
                        <div className="mt-1 text-lg font-medium">{c.title}</div>
                        <div className="mt-2 text-sm text-stone-600 dark:text-stone-400">
                          {recipeCountLabel(c)}
                          {c.isPublic && (
                            <span className="ml-2 text-emerald-700 dark:text-emerald-300">
                              · Public
                            </span>
                          )}
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function recipeCountLabel(c: LibraryCollectionSummary): string {
  const total = c.recipeCount;
  const filled = c.filledRecipeCount;
  if (total === 0) return '0 recipes';
  if (filled === total) return `${total} ${total === 1 ? 'recipe' : 'recipes'}`;
  // Total includes ToC placeholders the user hasn't imported yet. Show
  // the ratio so the user knows how much of the cookbook is "real".
  return `${filled} of ${total} imported`;
}

function collectionSubtitle(c: LibraryCollectionSummary): string {
  switch (c.sourceType) {
    case 'PUBLISHED_BOOK':
      return c.author ? `Cookbook · ${c.author}` : 'Cookbook';
    case 'WEBSITE':
      return c.siteName ? `Web · ${c.siteName}` : 'Web';
    case 'PERSONAL':
      return 'Personal';
    default:
      return 'Collection';
  }
}
