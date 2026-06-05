import { useEffect, useMemo, useState } from 'react';
import { Sentry } from '../sentry.js';
import { useSync } from '../local/SyncProvider.js';
import {
  getSyncLog,
  subscribeSyncLog,
  clearSyncLog,
  type SyncLogEntry,
} from '../local/syncLog.js';
import { listOutboxForDebug, outboxKindCounts } from '../local/outbox.js';
import { listWatermarks } from '../local/sync.js';
import { snapshotDbOps, snapshotDbInit, emergencyResetLocalDb } from '../local/db.js';
import {
  releaseLeadership,
  forceReelect,
  queryLeaderLockState,
} from '../local/tabLeader.js';
import type { OutboxEntry } from '../local/outbox.js';

interface DbOpView {
  id: number;
  label: string;
  state: 'waiting' | 'running';
  ageMs: number;
}

interface LockEntryView {
  name: string;
  clientId?: string;
  mode?: string;
}

interface Snapshot {
  outbox: OutboxEntry[];
  kindCounts: Record<string, number>;
  watermarks: { topic: string; high_water_mark: number }[];
  dbOps: DbOpView[];
  lockHeld: LockEntryView[];
  lockPending: LockEntryView[];
  lockSupported: boolean;
}

const EMPTY: Snapshot = {
  outbox: [],
  kindCounts: {},
  watermarks: [],
  dbOps: [],
  lockHeld: [],
  lockPending: [],
  lockSupported: true,
};

export function SyncDebugDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { status, pendingWrites, lastSyncedAt, lastError, syncingSince, tabRole, syncNow } =
    useSync();
  const [logEntries, setLogEntries] = useState<readonly SyncLogEntry[]>(() => getSyncLog());
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [refreshing, setRefreshing] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [confirmReset, setConfirmReset] = useState(false);
  const [upload, setUpload] = useState<
    | { state: 'idle' }
    | { state: 'sending' }
    | { state: 'sent'; eventId: string }
    | { state: 'error'; message: string }
  >({ state: 'idle' });

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
    const lockSnap = await queryLeaderLockState();
    setSnap((s) => ({
      ...s,
      lockHeld: lockSnap.held,
      lockPending: lockSnap.pending,
      lockSupported: lockSnap.supported,
    }));
    try {
      const [outbox, kindCounts, watermarks] = await Promise.all([
        listOutboxForDebug(),
        outboxKindCounts(),
        listWatermarks(),
      ]);
      setSnap({
        outbox,
        kindCounts,
        watermarks,
        dbOps,
        lockHeld: lockSnap.held,
        lockPending: lockSnap.pending,
        lockSupported: lockSnap.supported,
      });
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
          tabRole,
          kindCounts: snap.kindCounts,
          watermarks: snap.watermarks,
          dbOps: snap.dbOps,
          outbox: snap.outbox,
          log: logEntries.slice(-200),
        },
        null,
        2,
      ),
    [status, pendingWrites, lastSyncedAt, lastError, syncingSince, tabRole, snap, logEntries],
  );

  function copySummary() {
    navigator.clipboard.writeText(summary).then(() => {
      setPushed(true);
      setTimeout(() => setPushed(false), 1200);
    });
  }

  // Ship the same diagnostics blob "Copy debug" produces to Sentry as a
  // file attachment, so we can pull a user's sync state without asking
  // them to paste a wall of JSON. The summary can exceed Sentry's
  // per-field truncation, hence an attachment rather than `extra`. The
  // returned event id is shown so support can jump straight to it.
  async function uploadLogs() {
    setUpload({ state: 'sending' });
    try {
      const eventId = Sentry.withScope((scope) => {
        scope.setTag('report', 'sync-logs');
        // Small, queryable facets for triage in the issue list; the full
        // detail rides along in the attachment below.
        scope.setContext('sync', {
          status,
          pendingWrites,
          tabRole,
          lastError: lastError ?? null,
          lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : null,
        });
        scope.addAttachment({
          filename: 'sync-diagnostics.json',
          data: summary,
          contentType: 'application/json',
        });
        return Sentry.captureMessage('Sync logs (user-initiated upload)', 'info');
      });
      if (!eventId) {
        // No client / Sentry disabled (e.g. a local dev build without
        // VITE_SENTRY_ENABLE_DEV=1) — captureMessage no-ops and returns
        // undefined. Tell the user instead of faking success.
        setUpload({
          state: 'error',
          message: 'Sentry is not enabled in this build.',
        });
        return;
      }
      // Block on the flush so we only report success once the envelope
      // (event + attachment) has actually left the browser.
      await Sentry.flush(3000);
      setUpload({ state: 'sent', eventId });
      setTimeout(() => setUpload({ state: 'idle' }), 6000);
    } catch (err) {
      setUpload({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    }
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
              onClick={() => void uploadLogs()}
              disabled={upload.state === 'sending'}
              title={
                upload.state === 'sent'
                  ? `Sent to Sentry — event ${upload.eventId}`
                  : upload.state === 'error'
                    ? upload.message
                    : 'Send these diagnostics to Sentry as an attachment'
              }
              className={`rounded border px-3 py-1 text-xs disabled:opacity-50 ${
                upload.state === 'error'
                  ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950/30'
                  : 'border-stone-300 hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800'
              }`}
            >
              {upload.state === 'sending'
                ? 'Uploading…'
                : upload.state === 'sent'
                  ? `Sent ✓ ${upload.eventId.slice(0, 8)}`
                  : upload.state === 'error'
                    ? 'Upload failed'
                    : 'Upload sync logs'}
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
            <KV k="tab role" v={tabRole} />
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
            {tabRole === 'follower' && (
              <div className="mt-2 space-y-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                <p>
                  Another tab is the sync leader. This tab reads from the
                  local cache but doesn&apos;t push/pull or listen for
                  realtime updates.
                </p>
                <p className="text-amber-700 dark:text-amber-400">
                  If no other tab is open, the lock may be wedged — click
                  Force re-elect to reset.
                </p>
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {tabRole === 'leader' && (
                <button
                  type="button"
                  onClick={() => releaseLeadership()}
                  className="rounded border border-stone-300 px-2 py-0.5 text-xs hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
                  title="Release the sync lock so another open tab can take over."
                >
                  Release leadership
                </button>
              )}
              <button
                type="button"
                onClick={() => forceReelect()}
                className="rounded border border-stone-300 px-2 py-0.5 text-xs hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
                title="Tear down local lock state and re-run election."
              >
                Force re-elect
              </button>
            </div>
          </Section>

          <Section title="Web Locks">
            {!snap.lockSupported ? (
              <p className="text-xs text-stone-500">
                navigator.locks unavailable in this browser — auto-leader.
              </p>
            ) : (
              <>
                <div className="text-xs">
                  <span className="text-stone-500">held:</span>{' '}
                  {snap.lockHeld.length === 0 ? (
                    <span className="text-stone-500">none</span>
                  ) : (
                    <span className="font-mono">
                      {snap.lockHeld.length}
                      {snap.lockHeld[0]?.clientId
                        ? ` (clientId ${snap.lockHeld[0].clientId.slice(0, 8)}…)`
                        : ''}
                    </span>
                  )}
                </div>
                <div className="text-xs">
                  <span className="text-stone-500">pending:</span>{' '}
                  <span className="font-mono">{snap.lockPending.length}</span>
                </div>
                <p className="mt-1 text-[11px] text-stone-500">
                  If you only have one tab open but role is &quot;follower&quot;,
                  the lock is held by a stale context (a recently closed tab,
                  bfcached page). Force re-elect should clear it.
                </p>
              </>
            )}
          </Section>

          <DbInitSection now={now} />

          <Section title="Emergency reset" className="md:col-span-2">
            <p className="mb-2 text-xs text-stone-600 dark:text-stone-400">
              If <code>db init</code> is stuck, the persisted SQLite database is wedged.
              This deletes the local <code>idb-batch-atomic</code> IndexedDB and reloads —
              the next pull rehydrates from Supabase. Pending offline writes will be lost.
            </p>
            {!confirmReset ? (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-700 dark:bg-red-950/30 dark:text-red-400"
              >
                Reset local database…
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void emergencyResetLocalDb()}
                  className="rounded bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-800"
                >
                  Confirm wipe + reload
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
                >
                  Cancel
                </button>
              </div>
            )}
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

function DbInitSection({ now }: { now: number }) {
  const init = snapshotDbInit();
  const elapsed = init.startedAt
    ? (init.finishedAt ?? now) - init.startedAt
    : null;
  const stuck = !init.finishedAt && elapsed !== null && elapsed > 3000;
  return (
    <Section title="Local DB init">
      <KV k="step" v={init.step} mono />
      <KV
        k="elapsed"
        v={elapsed === null ? '—' : `${relMs(elapsed)}${stuck ? ' (stuck)' : ''}`}
      />
      <KV k="ready" v={init.finishedAt ? 'yes' : 'no'} />
      {init.error && <KV k="error" v={init.error} mono />}
    </Section>
  );
}
