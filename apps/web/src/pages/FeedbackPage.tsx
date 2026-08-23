import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { type FeedbackReportRow, listMyFeedback } from '../feedback/api.js';
import { FeedbackReportList } from '../feedback/FeedbackReportList.js';
import { openFeedbackDialog } from '../feedback/open.js';

/**
 * The reports you've filed. An online-only reporting surface like the LLM Cost
 * Center and Data Usage — it reads Supabase directly, not the local cache.
 */
export function FeedbackPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, isLoading, error } = useQuery<FeedbackReportRow[]>({
    queryKey: ['feedback', 'mine', refreshKey],
    queryFn: () => listMyFeedback(),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Feedback</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={openFeedbackDialog}
            className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-900"
          >
            Send feedback
          </button>
        </div>
      </div>

      <p className="text-sm text-stone-600 dark:text-stone-400">
        Reports you&apos;ve sent. Each one carries the actions you took just before it, recent
        errors, and your app version — so a problem can be traced without a back-and-forth.
      </p>

      {error ? (
        <p className="text-sm text-red-700 dark:text-red-400">
          Couldn&apos;t load your reports: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : isLoading ? (
        <p className="text-stone-500 dark:text-stone-400">Loading…</p>
      ) : (
        <FeedbackReportList reports={data ?? []} emptyHint="You haven't sent any feedback yet." />
      )}
    </div>
  );
}
