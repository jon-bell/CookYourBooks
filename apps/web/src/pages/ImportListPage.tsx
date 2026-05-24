import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useCollections } from '../data/queries.js';
import { useImportBatches, useOcrKeys } from '../import/queries.js';
import type { ImportBatch } from '../import/model.js';
import { LocalImportItemRepository } from '../import/localRepos.js';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';

interface BatchStats {
  total: number;
  done: number;
  failed: number;
  costUsdMicros: number;
}

function useBatchStats(ownerId: string | undefined, batchIds: string[]) {
  const { status } = useSync();
  return useQuery<Record<string, BatchStats>>({
    queryKey: ['import-batch-stats', ownerId, batchIds.join(',')],
    enabled: !!ownerId && status !== 'initializing',
    queryFn: async () => {
      const repo = new LocalImportItemRepository(ownerId!);
      const out: Record<string, BatchStats> = {};
      for (const id of batchIds) {
        const items = await repo.listByBatch(id);
        out[id] = {
          total: items.length,
          done: items.filter(
            (i) => i.status === 'REVIEWED' || i.status === 'OCR_DONE' || i.status === 'DISCARDED',
          ).length,
          failed: items.filter((i) => i.status === 'OCR_FAILED').length,
          costUsdMicros: items.reduce((acc, i) => acc + i.costUsdMicros, 0),
        };
      }
      return out;
    },
  });
}

export function ImportListPage() {
  const { user } = useAuth();
  const { data: batches = [], isLoading } = useImportBatches();
  const { data: collections = [] } = useCollections();
  const { data: ocrKeys = [] } = useOcrKeys();
  const batchIds = useMemo(() => batches.map((b) => b.id), [batches]);
  const { data: stats = {} } = useBatchStats(user?.id, batchIds);

  const collectionsById = useMemo(
    () => new Map(collections.map((c) => [c.id, c])),
    [collections],
  );

  const hasOcrKey = ocrKeys.length > 0;

  if (isLoading) return <p className="text-stone-500">Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Import OCR</h1>
        <Link
          to="/import/new"
          className="inline-flex items-center rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
        >
          New batch
        </Link>
      </div>

      {!hasOcrKey && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          OCR not configured — items won't be processed.{' '}
          <Link to="/settings" className="font-medium underline">
            Configure in Settings
          </Link>
          .
        </div>
      )}

      {batches.length === 0 ? (
        <p className="text-stone-600">
          No imports yet.{' '}
          <Link to="/import/new" className="underline">
            New batch →
          </Link>
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
          {batches.map((b) => (
            <li key={b.id}>
              <Link
                to={`/import/${b.id}`}
                className="flex flex-col gap-2 px-4 py-3 hover:bg-stone-50 sm:flex-row sm:items-center"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{b.name || '(untitled)'}</div>
                    <StatusBadge status={b.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-stone-500">
                    {b.targetCollectionId && collectionsById.has(b.targetCollectionId)
                      ? `→ ${collectionsById.get(b.targetCollectionId)!.title}`
                      : '→ (unassigned)'}
                    {' · '}
                    {formatRelative(b.updatedAt)}
                  </div>
                </div>
                <BatchProgress batch={b} stats={stats[b.id]} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BatchProgress({
  batch,
  stats,
}: {
  batch: ImportBatch;
  stats: BatchStats | undefined;
}) {
  const total = stats?.total ?? batch.totalItems;
  const done = stats?.done ?? 0;
  const failed = stats?.failed ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const cost = ((stats?.costUsdMicros ?? 0) / 1_000_000).toFixed(2);
  return (
    <div className="sm:w-64">
      <div className="flex justify-between text-xs text-stone-600">
        <span>
          {done} done / {total} total
          {failed > 0 && <span className="text-red-700"> / {failed} failed</span>}
        </span>
        <span>${cost}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full bg-stone-900" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'OPEN' | 'ARCHIVED' }) {
  const cls =
    status === 'ARCHIVED'
      ? 'bg-stone-200 text-stone-700'
      : 'bg-emerald-100 text-emerald-800';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {status === 'ARCHIVED' ? 'Archived' : 'Open'}
    </span>
  );
}

function formatRelative(ts: number): string {
  if (!ts) return 'just now';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
