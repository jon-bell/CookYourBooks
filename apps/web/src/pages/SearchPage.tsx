import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SourceType } from '@cookyourbooks/domain';
import { useSearch } from '../search/useSearch.js';
import { LoadingState } from '../components/LoadingState.js';

type Filter = '' | SourceType;

export function SearchPage() {
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');
  const [sourceType, setSourceType] = useState<Filter>('');

  // Debounce keystrokes; semantic search costs a model inference per
  // query so we don't want one per keypress.
  useEffect(() => {
    const id = setTimeout(() => setQ(raw), 250);
    return () => clearTimeout(id);
  }, [raw]);

  const { hits, isLoading, mode, embedderStatus } = useSearch(q);

  const filteredHits = useMemo(() => {
    if (!sourceType) return hits;
    return hits.filter((h) => (h.sourceType as string) === sourceType);
  }, [hits, sourceType]);

  const status = embedderHint(embedderStatus, mode);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Search</h1>
      <div className="flex flex-wrap gap-3">
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Search by recipe, ingredient, or idea (e.g. 'salad dressing')…"
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
      {status && (
        <div className="text-xs text-stone-500 dark:text-stone-400">{status}</div>
      )}
      {q.length === 0 ? (
        <p className="text-stone-500 dark:text-stone-400">
          Type to search across every recipe in your library.
        </p>
      ) : isLoading ? (
        <LoadingState surface="search" hints={['Searching every recipe…']} />
      ) : (
        <>
          <div className="text-sm text-stone-600 dark:text-stone-400">
            {filteredHits.length}{' '}
            {filteredHits.length === 1 ? 'result' : 'results'}
            {mode === 'substring' && embedderStatus === 'ready' && hits.length > 0 && (
              <span> (semantic search found nothing — showing literal matches)</span>
            )}
          </div>
          <ul className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
            {filteredHits.map((hit) => (
              <li key={hit.recipeId}>
                <Link
                  to={`/collections/${hit.collectionId}/recipes/${hit.recipeId}`}
                  className={`flex items-center justify-between gap-2 px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-900 ${
                    hit.isPlaceholder ? 'text-stone-500 dark:text-stone-500' : ''
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      title={hit.recipeTitle}
                      className={`line-clamp-2 min-w-0 ${hit.isPlaceholder ? '' : 'font-medium'}`}
                    >
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
                  <span className="shrink-0 text-sm text-stone-400">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function embedderHint(
  status: 'idle' | 'loading' | 'ready' | 'unavailable',
  mode: 'semantic' | 'substring' | 'empty',
): string | null {
  if (status === 'loading') {
    return 'Preparing semantic search (first time only, ~30 MB download)…';
  }
  if (status === 'unavailable' && mode !== 'empty') {
    return 'Semantic search unavailable — falling back to literal matches.';
  }
  return null;
}
