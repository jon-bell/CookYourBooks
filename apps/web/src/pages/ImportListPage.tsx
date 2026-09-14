import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { LoadingState } from '../components/LoadingState.js';
import { useCollections } from '../data/queries.js';
import { LocalImportItemRepository } from '../import/localRepos.js';
import type { ImportBatch } from '../import/model.js';
import { useImportBatches } from '../import/queries.js';
import { useOcrReadiness } from '../import/useOcrReadiness.js';
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
            (i) =>
              i.status === 'REVIEWED' ||
              i.status === 'OCR_DONE' ||
              i.status === 'BAKEOFF_READY' ||
              i.status === 'DISCARDED',
          ).length,
          failed: items.filter((i) => i.status === 'OCR_FAILED').length,
          costUsdMicros: items.reduce((acc, i) => acc + i.costUsdMicros, 0),
        };
      }
      return out;
    },
  });
}

const SECONDARY_CTA =
  'inline-flex items-center rounded-md border border-stone-300 dark:border-stone-600 px-3 py-1.5 text-sm hover:bg-stone-100 dark:hover:bg-stone-800';

export function ImportListPage() {
  const { user } = useAuth();
  const { data: batches = [], isLoading } = useImportBatches();
  const { data: collections = [] } = useCollections();
  const { ready: ocrReady } = useOcrReadiness();
  const batchIds = useMemo(() => batches.map((b) => b.id), [batches]);
  const { data: stats = {} } = useBatchStats(user?.id, batchIds);

  const collectionsById = useMemo(() => new Map(collections.map((c) => [c.id, c])), [collections]);

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
    return <LoadingState surface="import-list" />;
  }

  return (
    <div className="space-y-6">
      {showOnboarding && <OnboardingModal onDismiss={dismissOnboarding} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Add recipes</h1>
        <button
          type="button"
          onClick={() => {
            window.localStorage.removeItem('cookyourbooks.import.onboarded.v1');
            setShowOnboarding(true);
          }}
          className="ml-auto mr-2 text-xs text-stone-500 dark:text-stone-400 underline hover:text-stone-900 dark:hover:text-stone-100"
        >
          How it works
        </button>
        <Link to="/import/link" className={SECONDARY_CTA}>
          From a link
        </Link>
        <Link to="/import/pdf" className={SECONDARY_CTA}>
          From a PDF
        </Link>
        <Link to="/import/new" className={SECONDARY_CTA}>
          Upload photos
        </Link>
        <Link
          to="/import/scan"
          className="inline-flex items-center gap-1 rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1.5 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          <span aria-hidden>📷</span> Scan pages
        </Link>
      </div>

      {ocrReady === false && (
        <div
          role="status"
          className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200"
        >
          Importing isn't set up yet — items won't be processed.{' '}
          <Link to="/import/setup" className="font-medium underline">
            Set up importing
          </Link>
          .
        </div>
      )}

      {batches.length === 0 ? (
        <p className="text-stone-600 dark:text-stone-400">
          No imports yet.{' '}
          <Link to="/import/scan" className="underline">
            Scan some pages →
          </Link>
        </p>
      ) : (
        <ul
          aria-label="Recent imports"
          className="divide-y divide-stone-200 dark:divide-stone-700 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900"
        >
          {batches.map((b) => (
            <li key={b.id}>
              <Link
                to={`/import/${b.id}`}
                className="flex flex-col gap-2 px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-900 sm:flex-row sm:items-center"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{b.name || '(untitled)'}</div>
                    {b.batchKind === 'BAKEOFF' && (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-800">
                        Bakeoff
                      </span>
                    )}
                    <StatusBadge status={b.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
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
  const steps: Array<{ title: string; body: string }> = [
    {
      title: '1. Scan or upload pages',
      body: 'Scan a stack of cookbook pages with your camera, or drag in photos or a PDF. We split PDFs page-by-page automatically. 100+ pages at a time is fine — uploads stream.',
    },
    {
      title: '2. Worker OCRs in the background',
      body: 'Pages move from Pending → Processing → Needs review as Gemini reads them. Close the tab and come back later — work continues server-side.',
    },
    {
      title: '3. Review with scan on the left',
      body: 'Each page opens with the source image alongside the parsed recipe. Click any field — title, ingredient, step — to edit in place. Quantity has a structured editor with the real unit list.',
    },
    {
      title: '4. Merge stitched-wrong pages',
      body: 'When a recipe spans a page break, the worker can parse each page in isolation and split it into two items. On the batch board, tick the checkboxes for the related pages and click "Merge into one item" — the worker re-runs OCR with all images attached at once and the result lands on the earliest page. Absorbed pages move to Discarded automatically.',
    },
    {
      title: '5. Save and move on',
      body: 'Save commits the recipe to the target cookbook (matching ToC titles get updated in place) and jumps you to the next reviewable page. Discard, Re-OCR, and Restore original are always one click away.',
    },
    {
      title: '6. Keyboard',
      body: '← / k previous · → / j next · f fullscreen · esc to close · ? for this list. Edits inside fields keep their usual keys.',
    },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/70 p-6">
      <div className="my-12 w-full max-w-2xl rounded-lg bg-white dark:bg-stone-900 p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">How scanning works</h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Six steps. Most of the time you just scan, glance, and click Save.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="rounded p-1 text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            ×
          </button>
        </div>
        <ol className="mt-5 space-y-5">
          {steps.map((step) => (
            <li key={step.title}>
              <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                {step.title}
              </h3>
              <p className="mt-1 text-sm text-stone-700 dark:text-stone-300">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
          >
            Got it — let's scan
          </button>
        </div>
      </div>
    </div>
  );
}

function BatchProgress({ batch, stats }: { batch: ImportBatch; stats: BatchStats | undefined }) {
  const total = stats?.total ?? batch.totalItems;
  const done = stats?.done ?? 0;
  const failed = stats?.failed ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const cost = ((stats?.costUsdMicros ?? 0) / 1_000_000).toFixed(2);
  return (
    <div className="sm:w-64">
      <div className="flex justify-between text-xs text-stone-600 dark:text-stone-400">
        <span>
          {done} done / {total} total
          {failed > 0 && <span className="text-red-700 dark:text-red-300"> / {failed} failed</span>}
        </span>
        <span>${cost}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
        <div className="h-full bg-stone-900 dark:bg-stone-100" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'OPEN' | 'ARCHIVED' }) {
  const cls =
    status === 'ARCHIVED' ? 'bg-stone-200 text-stone-700' : 'bg-emerald-100 text-emerald-800';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
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
