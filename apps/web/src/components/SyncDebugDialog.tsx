import { useEffect, useMemo, useState } from 'react';
import { useSync } from '../local/SyncProvider.js';
import {
  getSyncLog,
  subscribeSyncLog,
  clearSyncLog,
  type SyncLogEntry,
} from '../local/syncLog.js';
import { listOutboxForDebug, outboxKindCounts } from '../local/outbox.js';
import { listWatermarks } from '../local/sync.js';
import { snapshotDbOps } from '../local/db.js';
import type { OutboxEntry } from '../local/outbox.js';

interface DbOpView {
  id: number;
  label: string;
  state: 'waiting' | 'running';
  ageMs: number;
}

interface Snapshot {
  outbox: OutboxEntry[];
  kindCounts: Record<string, number>;
  watermarks: { topic: string; high_water_mark: number }[];
  dbOps: DbOpView[];
}

const EMPTY: Snapshot = { outbox: [], kindCounts: {}, watermarks: [], dbOps: [] };

export function SyncDebugDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { status, pendingWrites, lastSyncedAt, lastError, syncingSince, syncNow } = useSync();
  const [logEntries, setLogEntries] = useState<readonly SyncLogEntry[]>(() => getSyncLog());
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [refreshing, setRefreshing] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const unsub = subscribeSyncLog(() => setLogEntries(getSyncLog()));
    setLogEntries(getSyncLog());
    return unsub;
  }, [open]);

  async function refreshSnapshot() {
    setRefreshing(true);
    // Read dbOps synchronously so a wedged SQLite mutex doesn't hide
    // the very state we're trying to diagnose. The outbox / watermark
    // reads go through the lock and will simply not resolve while it's
    // wedged — that's the diagnostic signal.
    const nowTs = Date.now();
    const dbOps: DbOpView[] = snapshotDbOps().map((o) => ({
      id: o.id,
      label: o.label,
      state: o.state,
      ageMs: nowTs - o.startedAt,
    }));
    setSnap((s) => ({ ...s, dbOps }));
    try {
      const [outbox, kindCounts, watermarks] = await Promise.all([
        listOutboxForDebug(),
        outboxKindCounts(),
        listWatermarks(),
      ]);
      setSnap({ outbox, kindCounts, watermarks, dbOps });
    } catch (err) {
      console.error('SyncDebugDialog refresh failed', err);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void refreshSnapshot();
    const id = setInterval(() => void refreshSnapshot(), 2000);
    return () => clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [open]);

  const summary = useMemo(
    () =>
      JSON.stringify(
        {
          status,
          pendingWrites,
          lastSyncedAt,
          lastError,
          syncingForMs: syncingSince ? Date.now() - syncingSince : null,
          kindCounts: snap.kindCounts,
          watermarks: snap.watermarks,
          dbOps: snap.dbOps,
          outbox: snap.outbox,
          log: logEntries.slice(-200),
        },
        null,
        2,
      ),
    [status, pendingWrites, lastSyncedAt, lastError, syncingSince, snap, logEntries],
  );

  function copySummary() {
    navigator.clipboard.writeText(summary).then(() => {
      setPushed(true);
      setTimeout(() => setPushed(false), 1200);
    });
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sync diagnostics"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-lg ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-700"
      >
        <header className="flex items-center justify-between border-b border-stone-200 px-5 py-3 dark:border-stone-700">
          <h2 className="text-base font-semibold">Sync diagnostics</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void syncNow()}
              className="rounded bg-stone-900 px-3 py-1 text-xs font-medium text-white hover:bg-stone-800"
            >
              Sync now
            </button>
            <button
              type="button"
              onClick={() => void refreshSnapshot()}
              disabled={refreshing}
              className="rounded border border-stone-300 px-3 py-1 text-xs hover:bg-stone-50 disabled:opacity-50 dark:border-stone-600 dark:hover:bg-stone-800"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={copySummary}
              className="rounded border border-stone-300 px-3 py-1 text-xs hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
            >
              {pushed ? 'Copied ✓' : 'Copy debug'}
            </button>
            <button
              type="button"
              onClick={clearSyncLog}
              className="rounded border border-stone-300 px-3 py-1 text-xs hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
            >
              Clear log
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded px-2 py-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-2">
          <Section title="Status">
            <KV k="state" v={status} />
            <KV
              k="syncing for"
              v={syncingSince ? relMs(now - syncingSince) : '—'}
            />
            <KV k="pending writes" v={String(pendingWrites)} />
            <KV
              k="last synced"
              v={lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString() : '—'}
            />
            <KV k="last error" v={lastError ?? '—'} mono />
          </Section>

          <Section title={`SQLite ops in flight (${snap.dbOps.length})`}>
            {snap.dbOps.length === 0 ? (
              <p className="text-sm text-stone-500">None.</p>
            ) : (
              <ul className="space-y-1 text-xs font-mono">
                {snap.dbOps.map((op) => (
                  <li
                    key={op.id}
                    className={
                      op.ageMs > 3000
                        ? 'text-red-700 dark:text-red-400'
                        : op.state === 'waiting'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-stone-700 dark:text-stone-300'
                    }
                  >
                    <span className="text-stone-400">#{op.id}</span>{' '}
                    <span className="uppercase">[{op.state}]</span> {relMs(op.ageMs)}{' '}
                    <span className="text-stone-500">{op.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Outbox kinds (${snap.outbox.length} total)`}>
            {Object.keys(snap.kindCounts).length === 0 ? (
              <p className="text-sm text-stone-500">Empty.</p>
            ) : (
              <ul className="text-sm">
                {Object.entries(snap.kindCounts).map(([kind, count]) => (
                  <li key={kind} className="flex justify-between">
                    <span className="font-mono">{kind}</span>
                    <span>{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Watermarks" className="md:col-span-2">
            {snap.watermarks.length === 0 ? (
              <p className="text-sm text-stone-500">None yet.</p>
            ) : (
              <table className="w-full text-left text-xs font-mono">
                <thead className="text-stone-500">
                  <tr>
                    <th className="py-1">topic</th>
                    <th className="py-1">high_water_mark</th>
                    <th className="py-1">as time</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.watermarks.map((w) => (
                    <tr key={w.topic} className="border-t border-stone-100 dark:border-stone-800">
                      <td className="py-1 pr-2">{w.topic}</td>
                      <td className="py-1 pr-2">{w.high_water_mark}</td>
                      <td className="py-1 text-stone-500">
                        {w.high_water_mark
                          ? new Date(w.high_water_mark).toLocaleString()
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Outbox queue (first 50)" className="md:col-span-2">
            {snap.outbox.length === 0 ? (
              <p className="text-sm text-stone-500">Empty.</p>
            ) : (
              <table className="w-full text-left text-xs font-mono">
                <thead className="text-stone-500">
                  <tr>
                    <th className="py-1">id</th>
                    <th className="py-1">kind</th>
                    <th className="py-1">entity_id</th>
                    <th className="py-1">attempts</th>
                    <th className="py-1">age</th>
                    <th className="py-1">last_error</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.outbox.slice(0, 50).map((e) => (
                    <tr key={e.id} className="border-t border-stone-100 dark:border-stone-800">
                      <td className="py-1 pr-2">{e.id}</td>
                      <td className="py-1 pr-2">{e.kind}</td>
                      <td className="py-1 pr-2 max-w-[20ch] truncate" title={e.entity_id}>
                        {e.entity_id}
                      </td>
                      <td className="py-1 pr-2">{e.attempts}</td>
                      <td className="py-1 pr-2 text-stone-500">
                        {relMs(Date.now() - e.enqueued_at)}
                      </td>
                      <td
                        className="py-1 max-w-[30ch] truncate text-red-700 dark:text-red-400"
                        title={e.last_error ?? ''}
                      >
                        {e.last_error ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Recent log" className="md:col-span-2">
            {logEntries.length === 0 ? (
              <p className="text-sm text-stone-500">No events yet.</p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded border border-stone-200 bg-stone-50 p-2 font-mono text-xs dark:border-stone-700 dark:bg-stone-950">
                {logEntries.slice(-200).map((e) => (
                  <div
                    key={e.id}
                    className={
                      e.level === 'error'
                        ? 'text-red-700 dark:text-red-400'
                        : e.level === 'warn'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-stone-700 dark:text-stone-300'
                    }
                  >
                    <span className="text-stone-400">
                      {new Date(e.at).toLocaleTimeString()}{' '}
                    </span>
                    {e.message}
                    {e.data && Object.keys(e.data).length > 0 ? (
                      <span className="text-stone-500"> {JSON.stringify(e.data)}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded border border-stone-200 p-3 dark:border-stone-700 ${className ?? ''}`}
    >
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-stone-500">{k}</span>
      <span className={`text-right ${mono ? 'font-mono break-all' : ''}`}>{v}</span>
    </div>
  );
}

function relMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}
