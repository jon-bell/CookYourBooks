import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { countSearchableEmbeddings } from '../local/repositories.js';
import { SEARCH_LIMIT, type SearchHit, searchHybrid, searchSubstring } from './semanticSearch.js';
import {
  type EmbedderStatus,
  getEmbedderStatus,
  preloadEmbedder,
  subscribeEmbedderStatus,
} from './workerClient.js';

export interface UseSearchResult {
  hits: SearchHit[];
  isLoading: boolean;
  /** What we actually queried with — semantic when the embedder + cache
   *  cooperate, otherwise the substring fallback. */
  mode: 'semantic' | 'substring' | 'empty';
  embedderStatus: EmbedderStatus;
  /** How many recipe vectors are mirrored locally and visible to this user.
   *  0 means the local cache is cold (embed queue undrained) — distinct from
   *  the embedder model failing to load. Surfaced in the page diagnostics. */
  embeddedCount: number;
  /** True when the result set hit the render cap, so the page can say "200+"
   *  instead of claiming the cap is the real total. */
  truncated: boolean;
}

/** Power-user diagnostic mirror, reusing the existing sync debug flag. */
function searchDebug(payload: Record<string, unknown>): void {
  try {
    if (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('cookyourbooks.sync.consoleMirror') === '1'
    ) {
      // eslint-disable-next-line no-console
      console.debug('[search]', payload);
    }
  } catch {
    // localStorage can throw in locked-down webviews; diagnostics are best-effort.
  }
}

/** `searchSubstring` fetches SEARCH_LIMIT + 1 rows; that extra row is the
 *  "there are more" signal and must not be rendered. */
function capSubstring(rows: SearchHit[]): {
  hits: SearchHit[];
  mode: 'substring';
  truncated: boolean;
} {
  const truncated = rows.length > SEARCH_LIMIT;
  return {
    hits: truncated ? rows.slice(0, SEARCH_LIMIT) : rows,
    mode: 'substring',
    truncated,
  };
}

function useEmbedderStatus(enabled: boolean): EmbedderStatus {
  const [s, setS] = useState<EmbedderStatus>(() => getEmbedderStatus());
  useEffect(() => {
    if (!enabled) return;
    if (getEmbedderStatus() === 'idle') {
      // Kick off load when the user lands on the search page. Errors
      // resolve via the status subscription.
      void preloadEmbedder().catch(() => {
        // Already surfaced through the 'unavailable' status; no need
        // to bubble.
      });
    }
    const unsub = subscribeEmbedderStatus(setS);
    return unsub;
  }, [enabled]);
  return s;
}

/**
 * Run a recipe search. Prefers semantic (local vector cosine) when the
 * embedder is ready, falls back to substring otherwise. Both paths run
 * against the same local SQLite tables, so there's no network
 * dependency — true offline support is a property of this hook.
 */
export function useSearch(q: string): UseSearchResult {
  const { user } = useAuth();
  const ownerId = user?.id;
  const trimmed = q.trim();
  const enabled = !!ownerId && trimmed.length > 0;
  const embedderStatus = useEmbedderStatus(enabled);

  const useSemantic = enabled && embedderStatus === 'ready';

  // Count of locally-mirrored vectors, independent of the query text — lets the
  // page tell "model didn't load" apart from "cache is cold". Cheap COUNT(*),
  // refreshed lazily.
  const { data: embeddedCount = 0 } = useQuery<number>({
    queryKey: ['search-embedded-count', ownerId],
    enabled: !!ownerId,
    queryFn: () => (ownerId ? countSearchableEmbeddings(ownerId) : Promise.resolve(0)),
    staleTime: 30_000,
  });

  const { data, isLoading } = useQuery<{
    hits: SearchHit[];
    mode: 'semantic' | 'substring';
    truncated: boolean;
  }>({
    queryKey: ['search', ownerId, trimmed, useSemantic ? 'sem' : 'sub'],
    enabled,
    queryFn: async ({ signal }) => {
      if (!ownerId || !trimmed) return { hits: [], mode: 'substring' as const, truncated: false };
      if (useSemantic) {
        // Hybrid: literal exact-term matches first, then semantic extras.
        // A one-word query like "salad" must surface every actual salad
        // ahead of merely-related soups/dressings that pure semantic
        // interleaves (gte-small's cosine band is too compressed to
        // separate them — see semanticSearch.ts).
        const hybrid = await searchHybrid(ownerId, trimmed, SEARCH_LIMIT, signal);
        if (hybrid.length > 0) {
          searchDebug({
            q: trimmed,
            mode: 'semantic',
            embedderStatus,
            embeddedCount,
            hits: hybrid.length,
          });
          return {
            hits: hybrid,
            mode: 'semantic' as const,
            truncated: hybrid.length >= SEARCH_LIMIT,
          };
        }
        // Cold cache: no vectors have been pulled / computed yet. Fall
        // through to substring so the user gets *something* useful while
        // the worker drains — and report the mode we ACTUALLY used so the
        // UI can tell the user it's showing literal matches.
        searchDebug({
          q: trimmed,
          mode: 'substring',
          reason: 'semantic-empty',
          embedderStatus,
          embeddedCount,
        });
        return capSubstring(await searchSubstring(ownerId, trimmed));
      }
      searchDebug({
        q: trimmed,
        mode: 'substring',
        reason: 'embedder-not-ready',
        embedderStatus,
        embeddedCount,
      });
      return capSubstring(await searchSubstring(ownerId, trimmed));
    },
    staleTime: 60_000,
  });

  if (!enabled) {
    return {
      hits: [],
      isLoading: false,
      mode: 'empty',
      embedderStatus,
      embeddedCount,
      truncated: false,
    };
  }
  return {
    hits: data?.hits ?? [],
    isLoading,
    truncated: data?.truncated ?? false,
    // Reflect the path actually taken — semantic can fall back to
    // substring on a cold cache. Before the query resolves, report the
    // intended mode.
    mode: data?.mode ?? (useSemantic ? 'semantic' : 'substring'),
    embedderStatus,
    embeddedCount,
  };
}
