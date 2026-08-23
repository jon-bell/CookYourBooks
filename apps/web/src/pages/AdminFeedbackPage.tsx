import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AdminTabs, RequireAdmin } from '../admin/RequireAdmin.js';
import {
  type FeedbackReportRow,
  type FeedbackStatus,
  listAllFeedback,
  setFeedbackStatus,
} from '../feedback/api.js';
import { FeedbackReportList } from '../feedback/FeedbackReportList.js';

const FILTERS: readonly (FeedbackStatus | 'all')[] = ['new', 'triaged', 'closed', 'all'];

/** Every user's reports. RLS grants the admin branch; this page just filters. */
export function AdminFeedbackPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<FeedbackStatus | 'all'>('new');

  const { data, isLoading, error } = useQuery<FeedbackReportRow[]>({
    queryKey: ['feedback', 'all', status],
    queryFn: () => listAllFeedback(status === 'all' ? {} : { status }),
    staleTime: 15_000,
  });

  async function onSetStatus(id: string, next: FeedbackStatus) {
    await setFeedbackStatus(id, next);
    await qc.invalidateQueries({ queryKey: ['feedback'] });
  }

  return (
    <RequireAdmin>
      <div className="space-y-5">
        <AdminTabs />
        <h1 className="text-2xl font-semibold">Feedback triage</h1>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatus(f)}
              className={`rounded-full px-3 py-1 text-sm ${
                status === f
                  ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                  : 'border border-stone-300 hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {error ? (
          <p className="text-sm text-red-700 dark:text-red-400">
            Couldn&apos;t load reports: {error instanceof Error ? error.message : String(error)}
          </p>
        ) : isLoading ? (
          <p className="text-stone-500 dark:text-stone-400">Loading…</p>
        ) : (
          <FeedbackReportList
            reports={data ?? []}
            emptyHint={`No ${status === 'all' ? '' : status} reports.`}
            onSetStatus={(id, next) => void onSetStatus(id, next)}
          />
        )}
      </div>
    </RequireAdmin>
  );
}
