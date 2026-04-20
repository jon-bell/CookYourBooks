import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  banUser,
  dismissReport,
  fetchCollectionTarget,
  listModerationActions,
  listReports,
  republishCollection,
  unbanUser,
  unpublishCollection,
  type CollectionTarget,
  type Report,
  type ReportStatus,
} from '../moderation/api.js';
import { ReasonDialog } from '../moderation/ReasonDialog.js';
import { useIsAdmin } from '../moderation/useIsAdmin.js';

type PendingAction =
  | { kind: 'unpublish'; collectionId: string }
  | { kind: 'ban'; userId: string }
  | { kind: 'ban-via-collection'; collectionId: string }
  | { kind: 'dismiss'; reportId: string }
  | { kind: 'unban'; userId: string }
  | { kind: 'republish'; collectionId: string };

type Tab = 'queue' | 'resolved' | 'log';

/**
 * Admin-only moderation console. Renders a forbidden message for non-admins
 * rather than returning 404 so the path is debuggable — the admins table
 * is the single source of truth and getting the answer wrong here should
 * not look like a routing bug.
 */
export function AdminPage() {
  const { isAdmin, isLoading } = useIsAdmin();
  const [tab, setTab] = useState<Tab>('queue');

  if (isLoading) return <p className="text-stone-500">Loading…</p>;
  if (!isAdmin) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-stone-600">
          This surface is restricted to administrators. If you think you should have access,
          ask another admin to grant it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Moderation</h1>
      <div className="flex gap-2 border-b border-stone-200 text-sm">
        <TabBtn active={tab === 'queue'} onClick={() => setTab('queue')}>
          Open reports
        </TabBtn>
        <TabBtn active={tab === 'resolved'} onClick={() => setTab('resolved')}>
          Resolved reports
        </TabBtn>
        <TabBtn active={tab === 'log'} onClick={() => setTab('log')}>
          Moderation log
        </TabBtn>
      </div>
      {tab === 'queue' && <ReportList status="OPEN" />}
      {tab === 'resolved' && <ReportList status="ACTIONED" showDismissed />}
      {tab === 'log' && <ModerationLog />}
    </div>
  );
}

function TabBtn({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px rounded-t border-b-2 px-3 py-2 ${
        active
          ? 'border-stone-900 font-medium text-stone-900'
          : 'border-transparent text-stone-600 hover:text-stone-900'
      }`}
    >
      {children}
    </button>
  );
}

function ReportList({ status, showDismissed }: { status: ReportStatus; showDismissed?: boolean }) {
  const queries = [useQuery({ queryKey: ['reports', status], queryFn: () => listReports(status) })];
  // For the "resolved" tab we show both ACTIONED and DISMISSED so admins
  // can see the full disposition history without switching tabs.
  const dismissed = useQuery({
    queryKey: ['reports', 'DISMISSED'],
    queryFn: () => listReports('DISMISSED'),
    enabled: !!showDismissed,
  });
  if (showDismissed) queries.push(dismissed);

  const isLoading = queries.some((q) => q.isLoading);
  const error = queries.find((q) => q.error)?.error as Error | undefined;
  const reports = [
    ...(queries[0]?.data ?? []),
    ...(showDismissed ? (queries[1]?.data ?? []) : []),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (isLoading) return <p className="text-stone-500">Loading reports…</p>;
  if (error) return <p className="text-red-700">{error.message}</p>;
  if (reports.length === 0) return <p className="text-stone-600">Nothing to review.</p>;

  return (
    <ul className="space-y-3">
      {reports.map((r) => (
        <ReportCard key={r.id} report={r} />
      ))}
    </ul>
  );
}

function ReportCard({ report }: { report: Report }) {
  const qc = useQueryClient();
  const invalidateReports = () => {
    qc.invalidateQueries({ queryKey: ['reports'] });
    qc.invalidateQueries({ queryKey: ['moderation-actions'] });
    qc.invalidateQueries({ queryKey: ['public-collections'] });
  };

  return (
    <li className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <span className="rounded bg-stone-100 px-2 py-0.5 font-medium">{report.reason}</span>
        <span>{new Date(report.created_at).toLocaleString()}</span>
        <span>· target {report.target_type.toLowerCase()}</span>
        <span
          className={`ml-auto rounded px-2 py-0.5 font-medium ${
            report.status === 'OPEN'
              ? 'bg-amber-50 text-amber-700'
              : report.status === 'ACTIONED'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-stone-100 text-stone-600'
          }`}
        >
          {report.status}
        </span>
      </div>
      {report.message && (
        <p className="mt-2 text-sm text-stone-700 whitespace-pre-wrap">{report.message}</p>
      )}
      {report.target_type === 'COLLECTION' && <CollectionTargetCard targetId={report.target_id} />}
      {report.status === 'OPEN' && (
        <ReportActions
          report={report}
          onAction={() => invalidateReports()}
        />
      )}
    </li>
  );
}

function CollectionTargetCard({ targetId }: { targetId: string }) {
  const { data, isLoading, error } = useQuery<CollectionTarget | null>({
    queryKey: ['moderation-target', 'COLLECTION', targetId],
    queryFn: () => fetchCollectionTarget(targetId),
  });
  if (isLoading) return <p className="mt-3 text-xs text-stone-500">Loading target…</p>;
  if (error) return <p className="mt-3 text-xs text-red-700">{(error as Error).message}</p>;
  if (!data) return <p className="mt-3 text-xs text-stone-500">Target no longer exists.</p>;
  return (
    <div className="mt-3 rounded border border-stone-200 bg-stone-50 p-3 text-sm">
      <div className="font-medium">{data.title}</div>
      <div className="mt-0.5 text-xs text-stone-600">
        by {data.owner_name ?? 'unknown'} · {data.recipe_count} recipes ·{' '}
        {data.is_public ? 'public' : 'private'}
        {data.disabled_owner && ' · owner banned'}
      </div>
    </div>
  );
}

function ReportActions({ report, onAction }: { report: Report; onAction: () => void }) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm(reason: string) {
    if (!pending) return;
    setError(null);
    try {
      if (pending.kind === 'unpublish') {
        await unpublishCollection(pending.collectionId, reason);
      } else if (pending.kind === 'ban') {
        await banUser(pending.userId, reason);
      } else if (pending.kind === 'ban-via-collection') {
        const col = await fetchCollectionTarget(pending.collectionId);
        if (!col) throw new Error('Target collection is gone');
        await banUser(col.owner_id, reason);
      } else if (pending.kind === 'dismiss') {
        await dismissReport(pending.reportId, reason);
      }
      setPending(null);
      onAction();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const dialogTitle = titleForPending(pending);
  const dialogLabel = confirmLabelForPending(pending);

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {report.target_type === 'COLLECTION' && (
        <button
          onClick={() => setPending({ kind: 'unpublish', collectionId: report.target_id })}
          className="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800"
        >
          Take down
        </button>
      )}
      {(report.target_type === 'COLLECTION' || report.target_type === 'USER') && (
        <button
          onClick={() =>
            setPending(
              report.target_type === 'USER'
                ? { kind: 'ban', userId: report.target_id }
                : { kind: 'ban-via-collection', collectionId: report.target_id },
            )
          }
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
        >
          Ban user
        </button>
      )}
      <button
        onClick={() => setPending({ kind: 'dismiss', reportId: report.id })}
        className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-100"
      >
        Dismiss
      </button>
      {error && <p className="w-full text-xs text-red-700">{error}</p>}
      <ReasonDialog
        open={pending !== null}
        title={dialogTitle}
        confirmLabel={dialogLabel}
        danger={pending?.kind === 'unpublish' || pending?.kind.startsWith('ban')}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
    </div>
  );
}

function titleForPending(p: PendingAction | null): string {
  if (!p) return '';
  switch (p.kind) {
    case 'unpublish':
      return 'Take the collection down';
    case 'ban':
    case 'ban-via-collection':
      return 'Ban this user';
    case 'dismiss':
      return 'Dismiss this report';
    case 'unban':
      return 'Unban this user';
    case 'republish':
      return 'Restore this collection';
  }
}

function confirmLabelForPending(p: PendingAction | null): string {
  if (!p) return 'Confirm';
  switch (p.kind) {
    case 'unpublish':
      return 'Take down';
    case 'ban':
    case 'ban-via-collection':
      return 'Ban user';
    case 'dismiss':
      return 'Dismiss';
    case 'unban':
      return 'Unban';
    case 'republish':
      return 'Restore';
  }
}

function ModerationLog() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['moderation-actions'],
    queryFn: () => listModerationActions(200),
  });

  async function confirm(reason: string) {
    if (!pending) return;
    if (pending.kind === 'unban') await unbanUser(pending.userId, reason);
    else if (pending.kind === 'republish')
      await republishCollection(pending.collectionId, reason);
    setPending(null);
    qc.invalidateQueries({ queryKey: ['moderation-actions'] });
    qc.invalidateQueries({ queryKey: ['public-collections'] });
  }

  if (isLoading) return <p className="text-stone-500">Loading log…</p>;
  if (error) return <p className="text-red-700">{(error as Error).message}</p>;
  if ((data ?? []).length === 0) return <p className="text-stone-600">No moderation actions yet.</p>;

  return (
    <ul className="space-y-2">
      {(data ?? []).map((a) => (
        <li
          key={a.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm"
        >
          <span className="rounded bg-stone-100 px-2 py-0.5 font-mono text-xs">{a.action}</span>
          <span className="text-stone-600">
            {a.target_type} · <code className="font-mono text-xs">{a.target_id.slice(0, 8)}</code>
          </span>
          {a.reason && <span className="text-stone-700">— {a.reason}</span>}
          <span className="ml-auto text-xs text-stone-500">
            {new Date(a.created_at).toLocaleString()}
          </span>
          {a.action === 'BAN_USER' && (
            <button
              onClick={() => setPending({ kind: 'unban', userId: a.target_id })}
              className="rounded-md border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100"
            >
              Unban
            </button>
          )}
          {a.action === 'UNPUBLISH' && (
            <button
              onClick={() => setPending({ kind: 'republish', collectionId: a.target_id })}
              className="rounded-md border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100"
            >
              Restore
            </button>
          )}
        </li>
      ))}
      <ReasonDialog
        open={pending !== null}
        title={titleForPending(pending)}
        confirmLabel={confirmLabelForPending(pending)}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
    </ul>
  );
}
