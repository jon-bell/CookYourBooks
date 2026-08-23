import type { SourceType } from '@cookyourbooks/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { LoadingState } from '../components/LoadingState.js';
import { useSearch } from '../search/useSearch.js';

type Filter = '' | SourceType;

const FILTERS: readonly Filter[] = ['', 'PERSONAL', 'PUBLISHED_BOOK', 'WEBSITE'];

function normalizeFilter(value: string | null): Filter {
  return FILTERS.includes(value as Filter) ? (value as Filter) : '';
}

/**
 * Search state (query + collection filter) lives in the URL, not in component
 * state. The router is declarative, so leaving /search for a recipe unmounts
 * this page — with the query in `useState` a Back (on iOS, the native WKWebView
 * edge-swipe) remounted it empty, throwing away the results and leaving the
 * global scroll restoration nothing tall enough to scroll to.
 *
 * With the query in the URL, a POP remounts with the query already present, so
 * `useSearch` re-fires on the same React Query key and — inside its 60s
 * staleTime — serves the cached hits on the first render. Results are back
 * before paint, which is exactly what `useScrollRestoration`'s rAF loop needs
 * to land the saved offset instead of timing out against an empty page.
 *
 * Writes are always `replace`, never `push`: a keystroke must not become a
 * back-stack entry.
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sourceType = normalizeFilter(params.get('type'));

  // The input stays local and uncommitted so typing is never debounced-laggy;
  // only the settled value reaches the URL. Seeded from the URL so a restored
  // search shows its own text.
  const [raw, setRaw] = useState(q);

  // Always the functional form, so a write never depends on a captured
  // snapshot of the params. `setSearchParams` only changes identity when the
  // location does, which the debounce effect already tracks via `q`.
  const writeParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mutate(next);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Tells our own debounced write apart from an externally-driven URL change
  // (Back/Forward, or a shared /search?q=… link) so the latter re-seeds the input.
  const lastWritten = useRef(q);
  useEffect(() => {
    if (q !== lastWritten.current) {
      lastWritten.current = q;
      setRaw(q);
    }
  }, [q]);

  // Debounce keystrokes; semantic search costs a model inference per
  // query so we don't want one per keypress.
  useEffect(() => {
    if (raw === q) return;
    const id = setTimeout(() => {
      lastWritten.current = raw;
      writeParams((next) => {
        if (raw) next.set('q', raw);
        else next.delete('q');
      });
    }, 250);
    return () => clearTimeout(id);
  }, [raw, q, writeParams]);

  // Focus-on-arrival is for a fresh search, not a restored one: raising the iOS
  // keyboard mid-restore would resize the body (Keyboard `resize: 'body'`) and
  // move scrollY out from under the restoration loop.
  const [autoFocusInput] = useState(() => q.length === 0);

  const { hits, isLoading, mode, embedderStatus, embeddedCount, truncated } = useSearch(q);

  const filteredHits = useMemo(() => {
    if (!sourceType) return hits;
    return hits.filter((h) => h.sourceType === sourceType);
  }, [hits, sourceType]);

  const status = embedderHint(embedderStatus, mode, embeddedCount);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Search</h1>
      <div className="flex flex-wrap gap-3">
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Search by recipe, ingredient, or idea (e.g. 'salad dressing')…"
          className="min-w-0 flex-1 rounded-md border border-stone-300 dark:border-stone-600 px-3 py-2"
          autoFocus={autoFocusInput}
        />
        <select
          value={sourceType}
          onChange={(e) => {
            const next = normalizeFilter(e.target.value);
            writeParams((p) => {
              if (next) p.set('type', next);
              else p.delete('type');
            });
          }}
          aria-label="Filter by collection type"
          className="rounded-md border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm"
        >
          <option value="">All collections</option>
          <option value="PERSONAL">Personal</option>
          <option value="PUBLISHED_BOOK">Cookbooks</option>
          <option value="WEBSITE">Web</option>
        </select>
      </div>
      {status && <div className="text-xs text-stone-500 dark:text-stone-400">{status}</div>}
      {q.length === 0 ? (
        <p className="text-stone-500 dark:text-stone-400">
          Type to search across every recipe in your library.
        </p>
      ) : isLoading ? (
        <LoadingState surface="search" hints={['Searching every recipe…']} />
      ) : (
        <>
          <div className="text-sm text-stone-600 dark:text-stone-400">
            {/* Only claim "more than this" when the count is the unfiltered
                cap — a source-type filter makes the total unknowable here. */}
            {filteredHits.length}
            {truncated && !sourceType ? '+' : ''} {filteredHits.length === 1 ? 'result' : 'results'}
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
                  <span className="shrink-0 text-sm text-stone-400 dark:text-stone-500">→</span>
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
  embeddedCount: number,
): string | null {
  if (status === 'loading') {
    return 'Preparing semantic search (first time only, ~30 MB download)…';
  }
  if (status === 'unavailable' && mode !== 'empty') {
    return 'Semantic search unavailable on this device — showing literal matches.';
  }
  // Semantic actually ran — never claim we fell back. (Keyed on the real mode,
  // not embeddedCount, whose async count query can lag the first results.)
  if (mode === 'semantic') {
    return embeddedCount > 0
      ? `Semantic search across ${embeddedCount} embedded ${embeddedCount === 1 ? 'recipe' : 'recipes'}.`
      : 'Semantic search active.';
  }
  // Embedder is ready but we fell back to literal with an empty local vector
  // cache: the embed queue hasn't drained to this device yet. Distinct cause
  // from a failed model load.
  if (status === 'ready' && mode === 'substring' && embeddedCount === 0) {
    return 'No recipes embedded on this device yet — showing literal matches while semantic search warms up.';
  }
  return null;
}
