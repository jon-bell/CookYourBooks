import { Link } from 'react-router-dom';
import { useLibrarySummaries } from '../data/queries.js';
import { useSync } from '../local/SyncProvider.js';
import type { LibraryCollectionSummary } from '../local/repositories.js';
import { CoverImage } from '../components/CoverImage.js';

export function LibraryPage() {
  const { localReady } = useSync();
  const { data: collections = [], isLoading, error } = useLibrarySummaries();

  const waitingForData = isLoading && collections.length === 0;

  if (!localReady || waitingForData) return <p className="text-stone-500 dark:text-stone-400">Loading…</p>;
  if (error) return <p className="text-red-700 dark:text-red-300">{(error as Error).message}</p>;

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
        <p className="text-stone-600 dark:text-stone-400">
          No collections yet. Create your first to start adding recipes.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <li
              key={c.id}
              className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 hover:border-stone-400"
            >
              <Link to={`/collections/${c.id}`} className="block">
                <CoverImage path={c.coverImagePath ?? undefined} className="aspect-[3/2] w-full" />
                <div className="p-4">
                  <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
                    {collectionSubtitle(c)}
                  </div>
                  <div className="mt-1 text-lg font-medium">{c.title}</div>
                  <div className="mt-2 text-sm text-stone-600 dark:text-stone-400">
                    {c.recipeCount} {c.recipeCount === 1 ? 'recipe' : 'recipes'}
                    {c.isPublic && <span className="ml-2 text-emerald-700 dark:text-emerald-300">· Public</span>}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
