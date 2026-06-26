import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider.js';
import { LoadingState } from '../components/LoadingState.js';
import type { LlmUsageRow, UsageGroupBy } from '../cost/api.js';
import { failureRatePct, featureLabel, formatTokens, formatUsdFromMicros } from '../cost/format.js';
import { useDisplayNames, useLlmUsage, useLlmUsageSummary } from '../cost/queries.js';

type RangeKey = '7d' | '30d' | 'all';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];

const GROUPS: { key: UsageGroupBy; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'provider', label: 'Provider' },
  { key: 'member', label: 'Member' },
  { key: 'feature', label: 'Feature' },
  { key: 'day', label: 'Day' },
];

function rangeFrom(range: RangeKey): string | undefined {
  if (range === 'all') return undefined;
  const days = range === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

const num = (x: number | string | null | undefined): number => Number(x ?? 0);

const PRODUCED_LABEL: Record<string, string> = {
  IMPORT_ITEM: 'OCR page',
  BAKEOFF_RUN: 'Bake-off',
  RECIPE: 'Recipe',
};

/**
 * LLM Cost Center — a read-only view of every LLM query the user (and their
 * household co-members, when library sharing is on) has run, with per-query
 * cost + key attribution and rollups. Reads the server-side reporting view
 * online (RLS scopes the rows); not part of the local-first cache.
 */
export function CostCenterPage() {
  const { user } = useAuth();
  const [range, setRange] = useState<RangeKey>('30d');
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('model');
  // Memoize so `from` (a Date.now()-derived ISO string) is stable across
  // renders — recomputing it inline would change the query key every render
  // and spin React Query in an infinite refetch loop.
  const from = useMemo(() => rangeFrom(range), [range]);

  const summary = useLlmUsageSummary({ from, groupBy });
  const usage = useLlmUsage({ from, limit: 500 });

  // Resolve display names for every key owner / member we might render.
  const memberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of summary.data ?? []) if (r.member_id) ids.add(r.member_id);
    for (const r of usage.data ?? []) if (r.key_owner_id) ids.add(r.key_owner_id);
    return [...ids];
  }, [summary.data, usage.data]);
  const names = useDisplayNames(memberIds);

  const nameFor = (id: string | null): string => {
    if (!id) return '—';
    if (id === user?.id) return 'You';
    return names.data?.get(id) ?? '(member)';
  };

  // Grand totals are the sum across the current rollup's buckets.
  const totals = useMemo(() => {
    const rows = summary.data ?? [];
    return rows.reduce(
      (acc, r) => ({
        queries: acc.queries + num(r.queries),
        tokens: acc.tokens + num(r.prompt_tokens) + num(r.completion_tokens),
        cost: acc.cost + num(r.cost_usd_micros),
        failures: acc.failures + num(r.failures),
      }),
      { queries: 0, tokens: 0, cost: 0, failures: 0 },
    );
  }, [summary.data]);

  if (!user) {
    return (
      <p className="text-stone-600 dark:text-stone-400">
        <Link to="/sign-in" className="underline">
          Sign in
        </Link>{' '}
        to view your LLM costs.
      </p>
    );
  }

  const bucketLabel = (bucket: string | null): string => {
    if (!bucket) return '—';
    if (groupBy === 'member') return nameFor(bucket);
    if (groupBy === 'feature') return featureLabel(bucket);
    return bucket;
  };

  return (
    <section className="space-y-6" data-testid="cost-center">
      <header>
        <h1 className="text-2xl font-semibold">LLM costs</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          Every query you've run against an LLM — OCR imports, model bake-offs, step rewrites, ISBN
          scans, and link imports — with per-query cost and which key paid. When household members
          share their library, their usage shows here too.
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
          onChange={(v) => setGroupBy(v as UsageGroupBy)}
        />
      </div>

      {summary.error && <p className="text-red-700 dark:text-red-300">{summary.error.message}</p>}

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Total spend"
          value={formatUsdFromMicros(totals.cost)}
          testid="cost-center-total"
        />
        <Stat label="Queries" value={totals.queries.toLocaleString()} />
        <Stat label="Tokens" value={formatTokens(totals.tokens)} />
        <Stat
          label="Failures"
          value={`${totals.failures.toLocaleString()} (${failureRatePct(totals.failures, totals.queries)}%)`}
        />
      </div>

      {/* Rollup */}
      <div>
        <h2 className="text-lg font-semibold">
          By {GROUPS.find((g) => g.key === groupBy)?.label.toLowerCase()}
        </h2>
        {summary.isLoading ? (
          <div className="mt-2">
            <LoadingState
              surface="cost-summary"
              hints={['Fetching the cost report from the server…']}
            />
          </div>
        ) : (summary.data ?? []).length === 0 ? (
          <p className="mt-2 text-stone-500 dark:text-stone-400">No usage in this period.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-md border border-stone-200 dark:border-stone-700">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 dark:bg-stone-800 text-left text-xs uppercase text-stone-500 dark:text-stone-400">
                <tr>
                  <th className="px-3 py-2 font-medium">
                    {GROUPS.find((g) => g.key === groupBy)?.label}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Queries</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Fails</th>
                  <th className="px-3 py-2 text-right font-medium">Avg ms</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                {[...(summary.data ?? [])]
                  .sort((a, b) => num(b.cost_usd_micros) - num(a.cost_usd_micros))
                  .map((r, i) => (
                    <tr key={`${r.bucket}-${i}`}>
                      <td className="px-3 py-2">{bucketLabel(r.bucket)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {num(r.queries).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatTokens(num(r.prompt_tokens) + num(r.completion_tokens))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatUsdFromMicros(num(r.cost_usd_micros))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {num(r.failures).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Math.round(num(r.avg_latency_ms))}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-query */}
      <div>
        <h2 className="text-lg font-semibold">Queries</h2>
        {usage.error && (
          <p className="mt-2 text-red-700 dark:text-red-300">{usage.error.message}</p>
        )}
        {usage.isLoading ? (
          <div className="mt-2">
            <LoadingState
              surface="cost-queries"
              hints={['Fetching the cost report from the server…']}
            />
          </div>
        ) : (usage.data ?? []).length === 0 ? (
          <p className="mt-2 text-stone-500 dark:text-stone-400" data-testid="cost-center-empty">
            No LLM queries yet. Run an import, bake-off, ISBN scan, or link import and the cost will
            show up here.
          </p>
        ) : (
          <div
            className="mt-2 overflow-x-auto rounded-md border border-stone-200 dark:border-stone-700"
            data-testid="cost-center-table"
          >
            <table className="w-full text-sm">
              <thead className="bg-stone-50 dark:bg-stone-800 text-left text-xs uppercase text-stone-500 dark:text-stone-400">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Feature</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Produced</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-700">
                {(usage.data ?? []).map((row) => (
                  <UsageRow key={row.id} row={row} who={nameFor(row.key_owner_id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function UsageRow({ row, who }: { row: LlmUsageRow; who: string }) {
  return (
    <tr data-testid={`cost-center-row-${row.feature}`}>
      <td className="px-3 py-2 whitespace-nowrap text-stone-600 dark:text-stone-400">
        {new Date(row.created_at).toLocaleString()}
      </td>
      <td className="px-3 py-2">{featureLabel(row.feature)}</td>
      <td className="px-3 py-2">
        <div>{row.model || '—'}</div>
        <div className="text-xs text-stone-500 dark:text-stone-400">{row.provider}</div>
      </td>
      <td className="px-3 py-2">
        <div>{who}</div>
        {row.key_fingerprint && (
          <div className="text-xs text-stone-500 dark:text-stone-400">
            <code>{row.key_fingerprint}</code>
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatTokens(row.prompt_tokens + row.completion_tokens)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatUsdFromMicros(row.cost_usd_micros)}
      </td>
      <td className="px-3 py-2">
        {row.succeeded ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
            OK
          </span>
        ) : (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-950/50 dark:text-red-300">
            {row.error_kind ?? 'error'}
          </span>
        )}
        {row.latency_ms > 0 && (
          <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            {row.latency_ms} ms
          </div>
        )}
      </td>
      <td className="px-3 py-2 max-w-[16rem]">
        <Produced kind={row.produced_kind} reference={row.produced_ref} />
      </td>
    </tr>
  );
}

function Produced({ kind, reference }: { kind: string | null; reference: string | null }) {
  if (!kind) return <span className="text-stone-400">—</span>;
  if (kind === 'VIDEO_URL' && reference) {
    return (
      <a
        href={reference}
        target="_blank"
        rel="noreferrer"
        className="break-all text-stone-700 underline dark:text-stone-300"
      >
        {reference.replace(/^https?:\/\//, '').slice(0, 48)}
      </a>
    );
  }
  if (kind === 'ISBN' && reference) {
    return <code className="text-xs">{reference}</code>;
  }
  return <span className="text-stone-500 dark:text-stone-400">{PRODUCED_LABEL[kind] ?? kind}</span>;
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
