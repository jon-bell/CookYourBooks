import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import {
  type EmbedderStatus,
  getEmbedderStatus,
  preloadEmbedder,
  subscribeEmbedderStatus,
} from './embedder.js';
import { type SearchHit, searchSemantic, searchSubstring } from './semanticSearch.js';

export interface UseSearchResult {
  hits: SearchHit[];
  isLoading: boolean;
  /** What we actually queried with — semantic when the embedder + cache
   *  cooperate, otherwise the substring fallback. */
  mode: 'semantic' | 'substring' | 'empty';
  embedderStatus: EmbedderStatus;
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

  const { data, isLoading } = useQuery<{ hits: SearchHit[]; mode: 'semantic' | 'substring' }>({
    queryKey: ['search', ownerId, trimmed, useSemantic ? 'sem' : 'sub'],
    enabled,
    queryFn: async () => {
      if (!ownerId || !trimmed) return { hits: [], mode: 'substring' as const };
      if (useSemantic) {
        const semantic = await searchSemantic(ownerId, trimmed);
        if (semantic.length > 0) return { hits: semantic, mode: 'semantic' as const };
        // Cold cache: no vectors have been pulled / computed yet. Fall
        // through to substring so the user gets *something* useful while
        // the worker drains — and report the mode we ACTUALLY used so the
        // UI can tell the user it's showing literal matches.
        return { hits: await searchSubstring(ownerId, trimmed), mode: 'substring' as const };
      }
      return { hits: await searchSubstring(ownerId, trimmed), mode: 'substring' as const };
    },
    staleTime: 60_000,
  });

  if (!enabled) {
    return { hits: [], isLoading: false, mode: 'empty', embedderStatus };
  }
  return {
    hits: data?.hits ?? [],
    isLoading,
    // Reflect the path actually taken — semantic can fall back to
    // substring on a cold cache. Before the query resolves, report the
    // intended mode.
    mode: data?.mode ?? (useSemantic ? 'semantic' : 'substring'),
    embedderStatus,
  };
}
