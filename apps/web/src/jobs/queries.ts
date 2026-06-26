import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../auth/AuthProvider.js';
import * as api from './api.js';
import { isInFlight } from './format.js';

// Online reads, no local cache, mirroring cost/queries.ts. The view isn't a
// realtime source, so we poll — but only while something is in flight, and
// stop once everything is terminal.
export function useJobs(range: api.JobsRange = {}) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['jobs', 'list', user?.id, range.from ?? null, range.limit ?? null],
    queryFn: () => api.listBatchJobs(range),
    enabled: !!user,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.some((r) => isInFlight(r.status)) ? 4000 : false;
    },
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: ({ kind, id }: { kind: api.JobKind; id: string }) => api.cancelJob(kind, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'list', user?.id] }),
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: ({ kind, id }: { kind: api.JobKind; id: string }) => api.retryJob(kind, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'list', user?.id] }),
  });
}
