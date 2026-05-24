import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCollections } from '../data/queries.js';
import {
  useImportBatch,
  useImportItems,
  useUpdateImportBatch,
  useUpdateImportItem,
} from '../import/queries.js';
import { setRecitationPolicy } from '../import/api.js';
import { ImportThumb } from '../import/ImportThumb.js';
import { LocalImportItemRepository } from '../import/localRepos.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useQuery } from '@tanstack/react-query';
import type { ImportItem, ImportItemStatus } from '../import/model.js';

type Filter =
  | 'ALL'
  | 'PENDING'
  | 'PROCESSING'
  | 'DONE'
  | 'NEEDS_REVIEW'
  | 'FAILED'
  | 'TOC';

function matchesFilter(item: ImportItem, filter: Filter): boolean {
  switch (filter) {
    case 'ALL':
      return true;
    case 'PENDING':
      return item.status === 'PENDING';
    case 'PROCESSING':
      return item.status === 'CLAIMED';
    case 'DONE':
      return item.status === 'REVIEWED';
    case 'NEEDS_REVIEW':
      return item.status === 'OCR_DONE' || item.status === 'NEEDS_FALLBACK';
    case 'FAILED':
      return item.status === 'OCR_FAILED';
    case 'TOC':
      return item.isToc;
  }
}

export function ImportBatchPage() {
  const { batchId } = useParams();
  const { user } = useAuth();
  const { data: batch } = useImportBatch(batchId);
  const { data: items = [] } = useImportItems(batchId);
  const { data: collections = [] } = useCollections();
  const updateBatch = useUpdateImportBatch();
  const updateItem = useUpdateImportItem();
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [recitationBusy, setRecitationBusy] = useState(false);

  const { data: attemptsByItem = {} } = useQuery<Record<string, number[]>>({
    queryKey: ['import-batch-rates', batchId],
    enabled: !!user && !!batchId,
    queryFn: async () => {
      const repo = new LocalImportItemRepository(user!.id);
      const out: Record<string, number[]> = {};
      for (const item of items) {
        const a = await repo.listAttempts(item.id);
        out[item.id] = a
          .filter((x) => x.finishedAt != null)
          .map((x) => x.finishedAt!);
      }
      return out;
    },
  });

  const collectionsById = useMemo(
    () => new Map(collections.map((c) => [c.id, c])),
    [collections],
  );

  const totalCost = items.reduce((acc, i) => acc + i.costUsdMicros, 0) / 1_000_000;

  const needsFallbackCount = items.filter((i) => i.status === 'NEEDS_FALLBACK').length;

  const { itemsPerMin, eta } = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    let recent = 0;
    let totalLatency = 0;
    let completed = 0;
    for (const finishes of Object.values(attemptsByItem)) {
      for (const t of finishes) {
        if (t >= cutoff) recent += 1;
        completed += 1;
        totalLatency += 1;
      }
    }
    const perMin = recent;
    const remaining = items.filter(
      (i) => i.status === 'PENDING' || i.status === 'CLAIMED',
    ).length;
    const avgPerItemSecs = completed > 0 && perMin > 0 ? 60 / perMin : 0;
    const etaSecs = remaining * avgPerItemSecs;
    return {
      itemsPerMin: perMin,
      eta: etaSecs > 0 && Number.isFinite(etaSecs) ? formatEta(etaSecs) : '—',
    };
  }, [attemptsByItem, items]);

  useEffect(() => {
    if (batch && !editingName) setNameDraft(batch.name);
  }, [batch, editingName]);

  if (!batch) return <p className="text-stone-500">Loading…</p>;

  const filtered = items.filter((i) => matchesFilter(i, filter));

  function toggleSelect(id: string, e: React.MouseEvent) {
    if (e.shiftKey || (e as unknown as MouseEvent).metaKey) {
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      e.preventDefault();
    }
  }

  async function applyBulk(
    patch: Parameters<typeof updateItem.mutateAsync>[0]['patch'],
  ) {
    for (const id of selected) {
      await updateItem.mutateAsync({ id, patch });
    }
    setSelected(new Set());
  }

  async function applyRecitation(policy: 'FALLBACK' | 'FAIL') {
    if (!batch) return;
    setRecitationBusy(true);
    try {
      await setRecitationPolicy(batch.id, policy);
      await updateBatch.mutateAsync({
        id: batch.id,
        patch: { recitationPolicy: policy },
      });
    } finally {
      setRecitationBusy(false);
    }
  }

  return (
    <div className="space-y-6 pb-20">
      {needsFallbackCount > 0 && batch.recitationPolicy === 'ASK' && (
        <div className="sticky top-0 z-10 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-medium">
            {needsFallbackCount} item{needsFallbackCount === 1 ? '' : 's'} hit copyright
            recitation.
          </div>
          <div className="mt-1">
            Use fallback model{batch.fallbackModel ? ` (${batch.fallbackModel})` : ''}?
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => applyRecitation('FALLBACK')}
              disabled={recitationBusy}
              className="rounded-md bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-60"
            >
              Yes, use fallback
            </button>
            <button
              type="button"
              onClick={() => applyRecitation('FAIL')}
              disabled={recitationBusy}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-100 disabled:opacity-60"
            >
              No, mark them failed
            </button>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-2">
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={async () => {
                if (nameDraft.trim() !== batch.name) {
                  await updateBatch.mutateAsync({
                    id: batch.id,
                    patch: { name: nameDraft.trim() },
                  });
                }
                setEditingName(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setNameDraft(batch.name);
                  setEditingName(false);
                }
              }}
              className="w-full rounded border border-stone-300 px-2 py-1 text-2xl font-semibold"
            />
          ) : (
            <h1
              tabIndex={0}
              role="button"
              onClick={() => setEditingName(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setEditingName(true);
              }}
              className="cursor-text rounded text-2xl font-semibold hover:bg-stone-100"
            >
              {batch.name || '(untitled)'}
            </h1>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-stone-600">
            <label className="flex items-center gap-1.5">
              <span>Target cookbook:</span>
              <select
                value={batch.targetCollectionId ?? ''}
                onChange={(e) =>
                  updateBatch.mutate({
                    id: batch.id,
                    patch: { targetCollectionId: e.target.value || null },
                  })
                }
                className="rounded border border-stone-300 px-2 py-1 text-sm"
              >
                <option value="">(unassigned)</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100">
            …
          </summary>
          <div className="absolute right-0 mt-1 w-48 rounded-md border border-stone-200 bg-white p-1 text-sm shadow-md">
            <button
              type="button"
              onClick={() =>
                updateBatch.mutate({
                  id: batch.id,
                  patch: { status: batch.status === 'ARCHIVED' ? 'OPEN' : 'ARCHIVED' },
                })
              }
              className="block w-full rounded px-3 py-1.5 text-left hover:bg-stone-100"
            >
              {batch.status === 'ARCHIVED' ? 'Unarchive batch' : 'Archive batch'}
            </button>
          </div>
        </details>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['ALL', 'All'],
            ['PENDING', 'Pending'],
            ['PROCESSING', 'Processing'],
            ['NEEDS_REVIEW', 'Needs review'],
            ['DONE', 'Done'],
            ['FAILED', 'Failed'],
            ['TOC', 'ToC'],
          ] as Array<[Filter, string]>
        ).map(([key, label]) => {
          const count = items.filter((i) => matchesFilter(i, key)).length;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded-full border px-3 py-1 text-xs ${
                filter === key
                  ? 'border-stone-900 bg-stone-900 text-white'
                  : 'border-stone-300 text-stone-700 hover:bg-stone-100'
              }`}
            >
              {label} <span className="opacity-70">({count})</span>
            </button>
          );
        })}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-stone-300 bg-stone-50 p-2 text-sm">
          <span>{selected.size} selected</span>
          <button
            type="button"
            onClick={() => applyBulk({ isToc: true, status: 'PENDING' })}
            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
          >
            Mark as ToC
          </button>
          <button
            type="button"
            onClick={() => applyBulk({ status: 'DISCARDED' })}
            className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
          >
            Discard
          </button>
          <ReassignBulkButton onApply={(collectionId) => applyBulk({ assignedCollectionId: collectionId })} />
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-stone-500 hover:text-stone-900"
          >
            Clear
          </button>
        </div>
      )}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {filtered.map((item) => {
          const draftTitle = item.parsedDrafts[0]?.title;
          const isSelected = selected.has(item.id);
          return (
            <li key={item.id}>
              <Link
                to={`/import/${batch.id}/items/${item.id}`}
                onClick={(e) => toggleSelect(item.id, e)}
                className={`block overflow-hidden rounded-lg border ${
                  isSelected
                    ? 'border-stone-900 ring-2 ring-stone-900'
                    : 'border-stone-200 hover:border-stone-400'
                } bg-white`}
              >
                <ImportThumb
                  path={item.thumbPath}
                  alt={`Page ${item.pageIndex + 1}`}
                  className="aspect-[3/4] w-full object-cover"
                />
                <div className="space-y-1 p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-stone-500">#{item.pageIndex + 1}</span>
                    <ItemStatusPill status={item.status} />
                  </div>
                  {draftTitle && (
                    <div className="truncate text-xs font-medium text-stone-800">
                      {draftTitle}
                    </div>
                  )}
                  {item.isToc && (
                    <div className="text-[10px] uppercase tracking-wide text-stone-500">
                      Table of Contents
                    </div>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {filtered.length === 0 && (
        <p className="text-stone-600">No items match this filter.</p>
      )}

      <div className="fixed inset-x-0 bottom-0 border-t border-stone-200 bg-white/95 px-4 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600">
          <span>
            Total cost: <strong>${totalCost.toFixed(2)}</strong>
          </span>
          <span>
            Throughput: <strong>{itemsPerMin}</strong> items/min
          </span>
          <span>
            ETA: <strong>{eta}</strong>
          </span>
          <span className="ml-auto text-stone-500">
            <Link to="/import" className="underline">
              ← All batches
            </Link>
          </span>
        </div>
      </div>
    </div>
  );

  function ReassignBulkButton({ onApply }: { onApply: (id: string | null) => void }) {
    return (
      <select
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value;
          e.target.value = '';
          if (v === '__unassign__') onApply(null);
          else if (v) onApply(v);
        }}
        className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
      >
        <option value="">Reassign…</option>
        <option value="__unassign__">(unassigned)</option>
        {collections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
    );
  }
}

function ItemStatusPill({ status }: { status: ImportItemStatus }) {
  const map: Record<ImportItemStatus, { label: string; cls: string }> = {
    PENDING: { label: 'Pending', cls: 'bg-stone-200 text-stone-700' },
    CLAIMED: { label: 'Processing', cls: 'bg-blue-100 text-blue-800' },
    OCR_DONE: { label: 'Needs review', cls: 'bg-amber-100 text-amber-800' },
    NEEDS_FALLBACK: { label: 'Needs fallback', cls: 'bg-orange-100 text-orange-800' },
    OCR_FAILED: { label: 'Failed', cls: 'bg-red-100 text-red-800' },
    REVIEWED: { label: 'Reviewed', cls: 'bg-emerald-100 text-emerald-800' },
    DISCARDED: { label: 'Discarded', cls: 'bg-stone-100 text-stone-500' },
  };
  const { label, cls } = map[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
