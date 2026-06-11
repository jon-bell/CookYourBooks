import { useQuery } from '@tanstack/react-query';

import { useAuth } from '../auth/AuthProvider.js';
import * as api from './api.js';

// All hooks gate on `!!user` and key on the user id — online reads, no local
// cache, mirroring household/queries.ts:useAuditLog.

export function useLlmUsage(range: api.UsageRange & { limit?: number }) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [
      'llm-usage',
      'list',
      user?.id,
      range.from ?? null,
      range.to ?? null,
      range.limit ?? null,
    ],
    queryFn: () => api.listLlmUsage(range),
    enabled: !!user,
  });
}

export function useLlmUsageSummary(opts: api.UsageRange & { groupBy: api.UsageGroupBy }) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['llm-usage', 'summary', user?.id, opts.groupBy, opts.from ?? null, opts.to ?? null],
    queryFn: () => api.getLlmUsageSummary(opts),
    enabled: !!user,
  });
}

/** Resolve display names for a stable set of user ids (key owners / members). */
export function useDisplayNames(ids: string[]) {
  const key = [...new Set(ids.filter(Boolean))].sort();
  return useQuery({
    queryKey: ['profiles', 'names', key],
    queryFn: () => api.fetchDisplayNames(key),
    enabled: key.length > 0,
  });
}
