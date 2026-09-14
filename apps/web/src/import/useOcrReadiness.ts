import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../auth/AuthProvider.js';
import { getEffectiveOcrConfig, type EffectiveOcrConfig } from './api.js';

/**
 * The one answer to "is importing set up?".
 *
 * Every entry point must ask this and nothing else. Asking `listOcrKeys()`
 * instead — as the hub and the old collection-page widget both used to —
 * only sees the user's *own* keys, so a household member running on the
 * owner's shared key was told importing wasn't set up while the import
 * itself would have worked fine.
 */
export function useOcrReadiness() {
  const { user } = useAuth();
  const q = useQuery<EffectiveOcrConfig | null>({
    queryKey: ['ocr-effective-config', user?.id],
    enabled: !!user,
    queryFn: () => getEffectiveOcrConfig().catch(() => null),
  });
  return {
    /** Undefined until resolved, so callers can avoid flashing the setup nudge. */
    ready: q.isPending ? undefined : q.data != null,
    config: q.data ?? null,
    isLoading: q.isPending,
  };
}
