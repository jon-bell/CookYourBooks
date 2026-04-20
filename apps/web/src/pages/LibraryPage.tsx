import { Link } from 'react-router-dom';
import type { RecipeCollection } from '@cookyourbooks/domain';
import { useCollections } from '../data/queries.js';
import { CoverImage } from '../components/CoverImage.js';

export function LibraryPage() {
  const { data: collections = [], isLoading, error } = useCollections();

  if (isLoading) return <p className="text-stone-500">Loading…</p>;
  if (error) return <p className="text-red-700">{(error as Error).message}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your library</h1>
        <Link
          to="/collections/new"
          className="inline-flex items-center rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
        >
          New collection
        </Link>
      </div>
      {collections.length === 0 ? (
        <p className="text-stone-600">
          No collections yet. Create your first to start adding recipes.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <li
              key={c.id}
              className="overflow-hidden rounded-lg border border-stone-200 bg-white hover:border-stone-400"
            >
              <Link to={`/collections/${c.id}`} className="block">
                <CoverImage path={c.coverImagePath} className="aspect-[3/2] w-full" />
                <div className="p-4">
                  <div className="text-xs uppercase tracking-wide text-stone-500">
                    {collectionSubtitle(c)}
                  </div>
                  <div className="mt-1 text-lg font-medium">{c.title}</div>
                  <div className="mt-2 text-sm text-stone-600">
                    {c.recipes.length} {c.recipes.length === 1 ? 'recipe' : 'recipes'}
                    {c.isPublic && <span className="ml-2 text-emerald-700">· Public</span>}
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

function collectionSubtitle(c: RecipeCollection): string {
  switch (c.sourceType) {
    case 'PUBLISHED_BOOK':
      return c.author ? `Cookbook · ${c.author}` : 'Cookbook';
    case 'WEBSITE':
      return c.siteName ? `Web · ${c.siteName}` : 'Web';
    case 'PERSONAL':
      return 'Personal';
  }
}
