import { useMemo } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { LoadingState } from '../components/LoadingState.js';
import { useDisplayNames } from '../cost/queries.js';
import { useRecipeSummaries } from '../data/queries.js';
import { type BatchJobRow, canCancel, canRetry } from '../jobs/api.js';
import {
  isInFlight,
  jobKindLabel,
  sortJobsForFeed,
  statusLabel,
  statusPillClass,
} from '../jobs/format.js';
import { useCancelJob, useJobs, useRetryJob } from '../jobs/queries.js';
import type { RecipeSummary } from '../local/repositories.js';

/**
 * Activity — a read-only live view of the user's (and, when library sharing is
 * on, their household co-members') background jobs across the six worker
 * queues: OCR import, bake-off, rewrite, remix, cover generation, and search
 * indexing. Reads the server-side `batch_jobs_report` view online (RLS scopes
 * the rows), exactly like the LLM Cost Center; not part of the local-first
 * cache. Owners can cancel queued work and retry failures inline.
 */
export function ActivityPage() {
  const { user } = useAuth();
  const jobs = useJobs();
  const cancel = useCancelJob();
  const retry = useRetryJob();

  const rows = useMemo(() => sortJobsForFeed(jobs.data ?? []), [jobs.data]);

  // Names for every owner / cover-initiator we render.
  const memberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.owner_id) ids.add(r.owner_id);
      if (r.requested_by) ids.add(r.requested_by);
    }
    return [...ids];
  }, [rows]);
  const names = useDisplayNames(memberIds);

  // Titles + collection for recipe-bound rows, resolved from the local cache.
  const recipeIds = useMemo(
    () => [
      ...new Set(
        rows
          .filter((r) => r.target_kind === 'recipe' && r.target_id)
          .map((r) => r.target_id as string),
      ),
    ],
    [rows],
  );
  const summaries = useRecipeSummaries(recipeIds);

  const nameFor = (id: string | null): string => {
    if (!id) return '—';
    if (id === user?.id) return 'You';
    return names.data?.get(id) ?? '(member)';
  };

  if (!user) {
    return (
      <p className="text-stone-600 dark:text-stone-400">
        <Link to="/sign-in" className="underline">
          Sign in
        </Link>{' '}
        to view your background jobs.
      </p>
    );
  }

  const pendingId = cancel.isPending
    ? cancel.variables?.id
    : retry.isPending
      ? retry.variables?.id
      : undefined;

  const inFlight = rows.filter((r) => isInFlight(r.status));
  const recent = rows.filter((r) => !isInFlight(r.status));

  const renderRow = (row: BatchJobRow) => (
    <JobRow
      key={`${row.kind}-${row.id}`}
      row={row}
      who={nameFor(row.requested_by ?? row.owner_id)}
      recipe={row.target_id ? summaries.data?.get(row.target_id) : undefined}
      mine={row.owner_id === user.id || row.requested_by === user.id}
      busy={pendingId === row.id}
      onCancel={() => cancel.mutate({ kind: row.kind, id: row.id })}
      onRetry={() => retry.mutate({ kind: row.kind, id: row.id })}
    />
  );

  return (
    <section className="space-y-6" data-testid="activity">
      <header>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          Background jobs — OCR imports, model bake-offs, step rewrites, recipe remixes, cover
          generation, and search indexing — with live status. When household members share their
          library, their jobs show here too.
        </p>
      </header>

      {jobs.error && <p className="text-red-700 dark:text-red-300">{jobs.error.message}</p>}
      {(cancel.error || retry.error) && (
        <p className="text-red-700 dark:text-red-300">
          {((cancel.error || retry.error) as Error).message}
        </p>
      )}

      {jobs.isLoading ? (
        <LoadingState surface="activity" hints={['Fetching background jobs…']} />
      ) : rows.length === 0 ? (
        <p className="text-stone-500 dark:text-stone-400" data-testid="activity-empty">
          No background jobs yet. Run an import, remix, or rewrite and it'll show up here.
        </p>
      ) : (
        <>
          {inFlight.length > 0 && (
            <JobSection title="In progress" testid="activity-inflight">
              {inFlight.map(renderRow)}
            </JobSection>
          )}
          {recent.length > 0 && (
            <JobSection title="Recent" testid="activity-recent">
              {recent.map(renderRow)}
            </JobSection>
          )}
        </>
      )}
    </section>
  );
}

function JobSection({
  title,
  testid,
  children,
}: {
  title: string;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testid}>
      <h2 className="text-lg font-semibold">{title}</h2>
      <ul className="mt-2 divide-y divide-stone-200 dark:divide-stone-700 rounded-md border border-stone-200 dark:border-stone-700">
        {children}
      </ul>
    </div>
  );
}

function JobRow({
  row,
  who,
  recipe,
  mine,
  busy,
  onCancel,
  onRetry,
}: {
  row: BatchJobRow;
  who: string;
  recipe: RecipeSummary | undefined;
  mine: boolean;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const link = jobLink(row, recipe);
  const showCancel = mine && canCancel(row.kind) && isInFlight(row.status);
  const showRetry = mine && canRetry(row.kind) && row.status === 'failed';
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
      data-testid={`activity-row-${row.kind}`}
    >
      <span className="font-medium">{jobKindLabel(row.kind)}</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${statusPillClass(row.status)}`}
        data-testid="activity-status"
      >
        {statusLabel(row.status)}
      </span>

      {link && (
        <Link
          to={link.to}
          className="max-w-[16rem] truncate text-stone-700 underline dark:text-stone-300"
        >
          {link.label}
        </Link>
      )}

      {row.kind === 'ocr' && (
        <span className="text-xs text-stone-500 dark:text-stone-400">{ocrSummary(row)}</span>
      )}

      {row.status === 'failed' && row.last_error && row.last_error !== 'CANCELLED' && (
        <span className="max-w-[18rem] truncate text-xs text-red-600 dark:text-red-400">
          {row.last_error}
        </span>
      )}

      <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">{who}</span>
      <time className="text-xs text-stone-400 dark:text-stone-500" dateTime={row.updated_at}>
        {timeAgo(row.updated_at)}
      </time>

      {(showCancel || showRetry) && (
        <span className="flex gap-2">
          {showCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              data-testid="activity-cancel"
              className="rounded border border-stone-300 dark:border-stone-600 px-2 py-0.5 text-xs hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {showRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              data-testid="activity-retry"
              className="rounded border border-stone-300 dark:border-stone-600 px-2 py-0.5 text-xs hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50"
            >
              Retry
            </button>
          )}
        </span>
      )}
    </li>
  );
}

/** Deep link for a job's target, or null when there's nothing to link to. */
function jobLink(
  row: BatchJobRow,
  recipe: RecipeSummary | undefined,
): { to: string; label: string } | null {
  if (row.target_kind === 'batch' && row.target_id) {
    return { to: `/import/${row.target_id}`, label: 'Open batch' };
  }
  if (row.target_kind === 'recipe' && row.target_id && recipe) {
    return {
      to: `/collections/${recipe.collectionId}/recipes/${row.target_id}`,
      label: recipe.title,
    };
  }
  return null;
}

/** "12/40 pages, 1 failed" for the OCR batch arm. */
function ocrSummary(row: BatchJobRow): string {
  const pending = row.pending_count ?? 0;
  const done = row.done_count ?? 0;
  const failed = row.failed_count ?? 0;
  const total = pending + done + failed;
  return `${done}/${total} pages${failed > 0 ? `, ${failed} failed` : ''}`;
}

/** Compact relative time for a feed (not localized — kept tiny + dependency-free). */
function timeAgo(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
