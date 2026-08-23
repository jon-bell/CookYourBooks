import { useState } from 'react';

import type { FeedbackReportRow, FeedbackStatus } from './api.js';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Shared renderer for the "my reports" page and the admin triage list. The
 * payload is collapsed behind a disclosure — it's the evidence, not the
 * headline, and it's long.
 */
export function FeedbackReportList({
  reports,
  emptyHint,
  onSetStatus,
}: {
  reports: readonly FeedbackReportRow[];
  emptyHint: string;
  /** Supplied only for admins; the update policy rejects everyone else. */
  onSetStatus?: (id: string, status: FeedbackStatus) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (reports.length === 0) {
    return <p className="text-stone-500 dark:text-stone-400">{emptyHint}</p>;
  }

  return (
    <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white dark:divide-stone-700 dark:border-stone-700 dark:bg-stone-900">
      {reports.map((r) => (
        <li key={r.id} className="px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                r.kind === 'bug'
                  ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300'
                  : 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300'
              }`}
            >
              {r.kind}
            </span>
            <span className="text-xs text-stone-500 dark:text-stone-400">{when(r.created_at)}</span>
            {r.route && (
              <code className="text-xs text-stone-500 dark:text-stone-400">{r.route}</code>
            )}
            {r.platform && (
              <span className="text-xs text-stone-500 dark:text-stone-400">{r.platform}</span>
            )}
            <span className="text-xs text-stone-500 dark:text-stone-400">
              {r.release ? `build ${r.release.slice(0, 8)}` : 'dev build'}
            </span>
            <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">{r.status}</span>
          </div>

          <p className="mt-1 whitespace-pre-wrap text-sm">{r.body}</p>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              className="text-xs text-stone-600 underline dark:text-stone-400"
            >
              {expanded === r.id ? 'Hide details' : 'Show details'}
            </button>
            {r.sentry_event_id && (
              <span className="text-xs text-stone-500 dark:text-stone-400">
                Sentry {r.sentry_event_id.slice(0, 8)}
              </span>
            )}
            {onSetStatus &&
              (['new', 'triaged', 'closed'] as const)
                .filter((s) => s !== r.status)
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSetStatus(r.id, s)}
                    className="rounded border border-stone-300 px-2 py-0.5 text-xs hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
                  >
                    Mark {s}
                  </button>
                ))}
          </div>

          {expanded === r.id && (
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-stone-50 p-2 text-[11px] leading-snug dark:bg-stone-950">
              {JSON.stringify(r.payload ?? {}, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}
