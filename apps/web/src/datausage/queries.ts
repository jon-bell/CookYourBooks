import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import * as api from './api.js';

// All hooks gate on `!!user` and key on the user id — online reads, no local
// cache, mirroring cost/queries.ts + household/queries.ts:useAuditLog.

export function useTransferEvents(range: api.TransferRange & { limit?: number }) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [
      'data-usage',
      'list',
      user?.id,
      range.from ?? null,
      range.to ?? null,
      range.limit ?? null,
    ],
    queryFn: () => api.listTransferEvents(range),
    enabled: !!user,
  });
}

export function useTransferSummary(opts: api.TransferRange & { groupBy: api.TransferGroupBy }) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['data-usage', 'summary', user?.id, opts.groupBy, opts.from ?? null, opts.to ?? null],
    queryFn: () => api.getTransferSummary(opts),
    enabled: !!user,
  });
}
