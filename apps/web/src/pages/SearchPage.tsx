import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SourceType } from '@cookyourbooks/domain';
import { useRecipeSearch } from '../data/queries.js';
type Filter = '' | SourceType;

export function SearchPage() {
  const [q, setQ] = useState('');
  const [sourceType, setSourceType] = useState<Filter>('');
  // SQL-backed search — no full-library hydration. The query already
  // matches title + ingredient name and sorts placeholders last.
  const { data: allHits = [], isLoading } = useRecipeSearch(q);
  const hits = sourceType
    ? allHits.filter((h) => (h.sourceType as string) === sourceType)
    : allHits;

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
            {hits.map((hit) => (
              <li key={hit.recipeId}>
                <Link
                  to={`/collections/${hit.collectionId}/recipes/${hit.recipeId}`}
                  className={`flex items-center justify-between px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-900 ${
                    hit.isPlaceholder ? 'text-stone-500 dark:text-stone-500' : ''
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`truncate ${hit.isPlaceholder ? '' : 'font-medium'}`}>
                      {hit.recipeTitle}
                    </span>
                    {hit.isPlaceholder && (
                      <span className="shrink-0 rounded border border-stone-300 dark:border-stone-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                        Not imported
                      </span>
                    )}
                    <span className="ml-2 truncate text-sm text-stone-500 dark:text-stone-400">
                      · {hit.collectionTitle}
                    </span>
                  </span>
                  <span className="text-sm text-stone-400">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
