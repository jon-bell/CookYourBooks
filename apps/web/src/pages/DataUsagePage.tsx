import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { LoadingState } from '../components/LoadingState.js';
import type { TransferEventRow, TransferGroupBy } from '../datausage/api.js';
import {
  directionLabel,
  formatBytes,
  formatCount,
  formatDuration,
  phaseLabel,
} from '../datausage/format.js';
import { useTransferEvents, useTransferSummary } from '../datausage/queries.js';

type RangeKey = '7d' | '30d' | 'all';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];

const GROUPS: { key: TransferGroupBy; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'direction', label: 'Direction' },
  { key: 'phase', label: 'Phase' },
];

function rangeFrom(range: RangeKey): string | undefined {
  if (range === 'all') return undefined;
  const days = range === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

const num = (x: number | string | null | undefined): number => Number(x ?? 0);

/**
 * Data Usage — a read-only view of how much data each sync cycle moved between
 * this device and the server (bytes / rows / requests / duration per phase and
 * direction), with rollups. When household members share their library, their
 * sync volume shows here too. Reads the server-side reporting view online (RLS
 * scopes the rows); not part of the local-first cache. Mirrors the LLM Cost
 * Center surface.
 */
export function DataUsagePage() {
  const { user } = useAuth();
  const [range, setRange] = useState<RangeKey>('30d');
  const [groupBy, setGroupBy] = useState<TransferGroupBy>('day');
  // Memoize so `from` (a Date.now()-derived ISO string) is stable across
  // renders — recomputing it inline would change the query key every render
  // and spin React Query in an infinite refetch loop.
  const from = useMemo(() => rangeFrom(range), [range]);

  const summary = useTransferSummary({ from, groupBy });
  const events = useTransferEvents({ from, limit: 500 });

  // Grand totals are the sum across the current rollup's buckets.
  const totals = useMemo(() => {
    const rows = summary.data ?? [];
    return rows.reduce(
      (acc, r) => ({
        bytes: acc.bytes + num(r.bytes),
        rows: acc.rows + num(r.rows),
        requests: acc.requests + num(r.requests),
        duration: acc.duration + num(r.duration_ms),
      }),
      { bytes: 0, rows: 0, requests: 0, duration: 0 },
    );
  }, [summary.data]);

  if (!user) {
    return (
      <p className="text-stone-600 dark:text-stone-400">
        <Link to="/sign-in" className="underline">
          Sign in
        </Link>{' '}
        to view your data usage.
      </p>
    );
  }

  const bucketLabel = (bucket: string | null): string => {
    if (!bucket) return '—';
    if (groupBy === 'direction') return directionLabel(bucket);
    if (groupBy === 'phase') return phaseLabel(bucket);
    return bucket;
  };

  return (
    <section className="space-y-6" data-testid="data-usage">
      <header>
        <h1 className="text-2xl font-semibold">Data usage</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          How much data syncing has moved between your devices and the server — bytes, rows, and
          requests per phase and direction, with timing. When household members share their library,
          their sync volume shows here too.
        </p>
      </header>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <Segmented
          label="Range"
          options={RANGES}
          value={range}
          onChange={(v) => setRange(v as RangeKey)}
        />
        <Segmented
          label="Group by"
          options={GROUPS}
          value={groupBy}
          onChange={(v) => setGroupBy(v as TransferGroupBy)}
        />
      </div>

      {summary.error && <p className="text-red-700 dark:text-red-300">{summary.error.message}</p>}

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total data" value={formatBytes(totals.bytes)} testid="data-usage-total" />
        <Stat label="Rows" value={formatCount(totals.rows)} />
        <Stat label="Requests" value={formatCount(totals.requests)} />
        <Stat label="Time" value={formatDuration(totals.duration)} />
      </div>

      {/* Rollup */}
      <div>
        <h2 className="text-lg font-semibold">
          By {GROUPS.find((g) => g.key === groupBy)?.label.toLowerCase()}
        </h2>
        {summary.isLoading ? (
          <div className="mt-2">
            <LoadingState
              surface="data-usage-summary"
              hints={['Fetching the usage report from the server…']}
            />
          </div>
        ) : (summary.data ?? []).length === 0 ? (
          <p className="mt-2 text-stone-500 dark:text-stone-400">
            No sync activity in this period.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-md border border-stone-200 dark:border-stone-700">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 dark:bg-stone-800 text-left text-xs uppercase text-stone-500 dark:text-stone-400">
                <tr>
                  <th className="px-3 py-2 font-medium">
                    {GROUPS.find((g) => g.key === groupBy)?.label}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Data</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                  <th className="px-3 py-2 text-right font-medium">Requests</th>
                  <th className="px-3 py-2 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                {[...(summary.data ?? [])]
                  .sort((a, b) => num(b.bytes) - num(a.bytes))
                  .map((r, i) => (
                    <tr key={`${r.bucket}-${i}`}>
                      <td className="px-3 py-2">{bucketLabel(r.bucket)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatBytes(num(r.bytes))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCount(num(r.rows))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCount(num(r.requests))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatDuration(num(r.duration_ms))}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-event */}
      <div>
        <h2 className="text-lg font-semibold">Recent transfers</h2>
        {events.error && (
          <p className="mt-2 text-red-700 dark:text-red-300">{events.error.message}</p>
        )}
        {events.isLoading ? (
          <div className="mt-2">
            <LoadingState
              surface="data-usage-events"
              hints={['Fetching the usage report from the server…']}
            />
          </div>
        ) : (events.data ?? []).length === 0 ? (
          <p className="mt-2 text-stone-500 dark:text-stone-400" data-testid="data-usage-empty">
            No sync transfers recorded yet. They'll appear here as syncing runs.
          </p>
        ) : (
          <div
            className="mt-2 overflow-x-auto rounded-md border border-stone-200 dark:border-stone-700"
            data-testid="data-usage-table"
          >
            <table className="w-full text-sm">
              <thead className="bg-stone-50 dark:bg-stone-800 text-left text-xs uppercase text-stone-500 dark:text-stone-400">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Direction</th>
                  <th className="px-3 py-2 font-medium">Phase</th>
                  <th className="px-3 py-2 text-right font-medium">Data</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                  <th className="px-3 py-2 text-right font-medium">Requests</th>
                  <th className="px-3 py-2 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                {(events.data ?? []).map((row) => (
                  <EventRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function EventRow({ row }: { row: TransferEventRow }) {
  return (
    <tr data-testid={`data-usage-row-${row.direction}`}>
      <td className="px-3 py-2 whitespace-nowrap text-stone-600 dark:text-stone-400">
        {new Date(row.created_at).toLocaleString()}
      </td>
      <td className="px-3 py-2">
        {row.direction === 'push' ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            Push
          </span>
        ) : (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-950/50 dark:text-sky-300">
            Pull
          </span>
        )}
      </td>
      <td className="px-3 py-2">{phaseLabel(row.phase)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatBytes(row.bytes)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatCount(row.rows)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatCount(row.requests)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatDuration(row.duration_ms)}</td>
    </tr>
  );
}

function Stat({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="rounded-md border border-stone-200 dark:border-stone-700 px-3 py-2">
      <div className="text-xs uppercase text-stone-500 dark:text-stone-400">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums" data-testid={testid}>
        {value}
      </div>
    </div>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { key: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase text-stone-500 dark:text-stone-400">{label}</div>
      <div className="inline-flex rounded-md border border-stone-300 dark:border-stone-600 overflow-hidden">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={value === o.key}
            className={`px-3 py-1.5 text-sm ${
              value === o.key
                ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                : 'bg-white text-stone-700 hover:bg-stone-100 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
