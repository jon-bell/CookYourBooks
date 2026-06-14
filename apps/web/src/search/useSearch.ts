import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import { countSearchableEmbeddings } from '../local/repositories.js';
import {
  getEmbedderStatus,
  preloadEmbedder,
  subscribeEmbedderStatus,
  type EmbedderStatus,
} from './embedder.js';
import { searchSemantic, searchSubstring, type SearchHit } from './semanticSearch.js';

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

  const { data, isLoading } = useQuery<{ hits: SearchHit[]; mode: 'semantic' | 'substring' }>({
    queryKey: ['search', ownerId, trimmed, useSemantic ? 'sem' : 'sub'],
    enabled,
    queryFn: async () => {
      if (!ownerId || !trimmed) return { hits: [], mode: 'substring' as const };
      if (useSemantic) {
        const semantic = await searchSemantic(ownerId, trimmed);
        if (semantic.length > 0) {
          searchDebug({ q: trimmed, mode: 'semantic', embedderStatus, embeddedCount, hits: semantic.length });
          return { hits: semantic, mode: 'semantic' as const };
        }
        // Cold cache: no vectors have been pulled / computed yet. Fall
        // through to substring so the user gets *something* useful while
        // the worker drains — and report the mode we ACTUALLY used so the
        // UI can tell the user it's showing literal matches.
        searchDebug({ q: trimmed, mode: 'substring', reason: 'semantic-empty', embedderStatus, embeddedCount });
        return { hits: await searchSubstring(ownerId, trimmed), mode: 'substring' as const };
      }
      searchDebug({ q: trimmed, mode: 'substring', reason: 'embedder-not-ready', embedderStatus, embeddedCount });
      return { hits: await searchSubstring(ownerId, trimmed), mode: 'substring' as const };
    },
    staleTime: 60_000,
  });

  if (!enabled) {
    return { hits: [], isLoading: false, mode: 'empty', embedderStatus, embeddedCount };
  }
  return {
    hits: data?.hits ?? [],
    isLoading,
    // Reflect the path actually taken — semantic can fall back to
    // substring on a cold cache. Before the query resolves, report the
    // intended mode.
    mode: data?.mode ?? (useSemantic ? 'semantic' : 'substring'),
    embedderStatus,
    embeddedCount,
  };
}
