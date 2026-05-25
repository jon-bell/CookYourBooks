import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { searchLibrary, type SourceType } from '@cookyourbooks/domain';
import { useCollections } from '../data/queries.js';
type Filter = '' | SourceType;

export function SearchPage() {
  const [q, setQ] = useState('');
  const [sourceType, setSourceType] = useState<Filter>('');
  const { data: collections = [], isLoading } = useCollections();
  const hits = useMemo(() => {
    const visible = sourceType
      ? collections.filter((c) => c.sourceType === sourceType)
      : collections;
    const raw = searchLibrary(visible, q);
    // Imported recipes lead; ToC placeholders (no ingredients + no
    // instructions) sink to the bottom. Stable within each group.
    return [...raw].sort((a, b) => {
      const af = a.recipe.ingredients.length > 0 || a.recipe.instructions.length > 0 ? 0 : 1;
      const bf = b.recipe.ingredients.length > 0 || b.recipe.instructions.length > 0 ? 0 : 1;
      return af - bf;
    });
  }, [collections, q, sourceType]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Search</h1>
      <div className="flex flex-wrap gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by recipe title or ingredient…"
          className="flex-1 rounded-md border border-stone-300 dark:border-stone-600 px-3 py-2"
          autoFocus
        />
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as Filter)}
          aria-label="Filter by collection type"
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm"
        >
          <option value="">All collections</option>
          <option value="PERSONAL">Personal</option>
          <option value="PUBLISHED_BOOK">Cookbooks</option>
          <option value="WEBSITE">Web</option>
        </select>
      </div>
      {isLoading ? (
        <p className="text-stone-500 dark:text-stone-400">Loading…</p>
      ) : (
        <>
          <div className="text-sm text-stone-600 dark:text-stone-400">
            {q
              ? `${hits.length} ${hits.length === 1 ? 'result' : 'results'}`
              : `${hits.length} recipes`}
          </div>
          <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
            {hits.map(({ collection, recipe }) => {
              const isPlaceholder =
                recipe.ingredients.length === 0 && recipe.instructions.length === 0;
              return (
                <li key={recipe.id}>
                  <Link
                    to={`/collections/${collection.id}/recipes/${recipe.id}`}
                    className={`flex items-center justify-between px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-900 ${
                      isPlaceholder ? 'text-stone-500 dark:text-stone-500' : ''
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`truncate ${isPlaceholder ? '' : 'font-medium'}`}>
                        {recipe.title}
                      </span>
                      {isPlaceholder && (
                        <span className="shrink-0 rounded border border-stone-300 dark:border-stone-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                          Not imported
                        </span>
                      )}
                      <span className="ml-2 truncate text-sm text-stone-500 dark:text-stone-400">
                        · {collection.title}
                      </span>
                    </span>
                    <span className="text-sm text-stone-400">→</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
