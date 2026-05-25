import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCollections } from '../data/queries.js';
import { useImportBatches, useOcrKeys } from '../import/queries.js';
import type { ImportBatch } from '../import/model.js';
import { LocalImportItemRepository } from '../import/localRepos.js';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider.js';
import { useLocalQueryEnabled } from '../local/SyncProvider.js';

interface BatchStats {
  total: number;
  done: number;
  failed: number;
  costUsdMicros: number;
}

function useBatchStats(ownerId: string | undefined, batchIds: string[]) {
  const enabled = useLocalQueryEnabled();
  return useQuery<Record<string, BatchStats>>({
    queryKey: ['import-batch-stats', ownerId, batchIds.join(',')],
    enabled: enabled && batchIds.length > 0,
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
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem('cookyourbooks.import.onboarded.v1')) return;
    setShowOnboarding(true);
  }, []);
  function dismissOnboarding() {
    window.localStorage.setItem('cookyourbooks.import.onboarded.v1', '1');
    setShowOnboarding(false);
  }

  if (isLoading) {
    return <p className="text-stone-500">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      {showOnboarding && <OnboardingModal onDismiss={dismissOnboarding} />}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Import OCR</h1>
        <button
          type="button"
          onClick={() => {
            window.localStorage.removeItem('cookyourbooks.import.onboarded.v1');
            setShowOnboarding(true);
          }}
          className="ml-auto mr-2 text-xs text-stone-500 underline hover:text-stone-900"
        >
          How it works
        </button>
        <Link
          to="/import/bakeoff"
          className="inline-flex items-center rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100"
        >
          Bakeoff
        </Link>
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

function OnboardingModal({ onDismiss }: { onDismiss: () => void }) {
  const steps: Array<{ title: string; body: string; placeholder: string }> = [
    {
      title: '1. Upload pages',
      body:
        'Drag in a stack of cookbook photos, or upload a PDF. We split PDFs page-by-page automatically. 100+ pages at a time is fine — uploads stream.',
      placeholder: '[screenshot: drag-drop wizard]',
    },
    {
      title: '2. Worker OCRs in the background',
      body:
        'Pages move from Pending → Processing → Needs review as Gemini reads them. Close the tab and come back later — work continues server-side.',
      placeholder: '[screenshot: batch board with progress + cost]',
    },
    {
      title: '3. Review with scan on the left',
      body:
        'Each page opens with the source image alongside the parsed recipe. Click any field — title, ingredient, step — to edit in place. Quantity has a structured editor with the real unit list.',
      placeholder: '[screenshot: split editor]',
    },
    {
      title: '4. Merge stitched-wrong pages',
      body:
        'When a recipe spans a page break, the worker can parse each page in isolation and split it into two items. On the batch board, tick the checkboxes for the related pages and click "Merge into one item" — the worker re-runs OCR with all images attached at once and the result lands on the earliest page. Absorbed pages move to Discarded automatically.',
      placeholder: '[screenshot: bulk select + merge]',
    },
    {
      title: '5. Save and move on',
      body:
        'Save commits the recipe to the target cookbook (matching ToC titles get updated in place) and jumps you to the next reviewable page. Discard, Re-OCR, and Restore original are always one click away.',
      placeholder: '[screenshot: save toast + jump]',
    },
    {
      title: '6. Keyboard',
      body:
        '← / k previous · → / j next · f fullscreen · esc to close · ? for this list. Edits inside fields keep their usual keys.',
      placeholder: '[screenshot: kbd cheatsheet]',
    },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/70 p-6">
      <div className="my-12 w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">How bulk import works</h2>
            <p className="mt-1 text-sm text-stone-600">
              Five steps. Most of the time you just upload, glance, and click Save.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="rounded p-1 text-stone-500 hover:bg-stone-100"
          >
            ×
          </button>
        </div>
        <ol className="mt-5 space-y-5">
          {steps.map((step) => (
            <li key={step.title} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
              <div>
                <h3 className="text-sm font-semibold text-stone-900">{step.title}</h3>
                <p className="mt-1 text-sm text-stone-700">{step.body}</p>
              </div>
              <div className="flex h-20 w-40 items-center justify-center rounded-md border border-dashed border-stone-300 bg-stone-50 text-[10px] text-stone-400">
                {step.placeholder}
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            Got it — let's import
          </button>
        </div>
      </div>
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
