// Shared sync-diagnostics builder + automatic capture.
//
// The user-initiated "upload sync logs" button (SyncDebugDialog) and the
// automatic capture on a wedged cycle both want the same snapshot — DB ops,
// watermarks, outbox, recent log — so it lives here instead of being rebuilt
// per call site. Auto-capture is heavily throttled and trimmed so a wedged
// device (which retries every few seconds) can't spam Sentry the way the
// incident device did with 14 manual uploads.

import { Sentry } from '../sentry.js';
import { getSyncLog } from './syncLog.js';
import { listOutboxForDebug, outboxKindCounts } from './outbox.js';
import { listWatermarks } from './sync.js';
import { snapshotDbOps, readDbStats } from './db.js';
import { getTabRole } from './tabLeader.js';

export interface SyncFacets {
  status: string;
  pendingWrites?: number;
  lastSyncedAt?: number | null;
  lastError?: string | null;
  syncingForMs?: number | null;
  outcome?: string;
}

/**
 * Assemble the full diagnostics object. `logLimit` trims the log ring buffer —
 * the manual upload sends a generous tail, the auto-capture a compact one.
 */
export async function gatherSyncDiagnostics(
  facets: SyncFacets,
  logLimit = 200,
): Promise<Record<string, unknown>> {
  const [outbox, kindCounts, watermarks] = await Promise.all([
    listOutboxForDebug().catch(() => []),
    outboxKindCounts().catch(() => ({}) as Record<string, number>),
    listWatermarks().catch(() => [] as { topic: string; high_water_mark: number }[]),
  ]);
  const dbOps = snapshotDbOps().map((o) => ({
    id: o.id,
    label: o.label,
    state: o.state,
    ageMs: Date.now() - o.startedAt,
  }));
  return {
    ...facets,
    tabRole: getTabRole(),
    dbStats: readDbStats(),
    kindCounts,
    watermarks,
    dbOps,
    outbox,
    log: getSyncLog().slice(-logLimit),
  };
}

// ---------- throttled auto-capture ----------

const MIN_INTERVAL_MS = 10 * 60 * 1000; // ≤1 auto-capture per 10 min
const MAX_PER_SESSION = 5;
let lastCaptureAt = 0;
let captureCount = 0;

/**
 * Capture a trimmed sync-diagnostics event to Sentry on a wedged/slow cycle —
 * no user action needed. Returns the event id, or null if throttled / Sentry
 * isn't initialized. Safe to call on every failed cycle; it self-limits.
 */
export async function captureSyncDiagnostics(facets: SyncFacets): Promise<string | null> {
  const now = Date.now();
  if (captureCount >= MAX_PER_SESSION) return null;
  if (now - lastCaptureAt < MIN_INTERVAL_MS) return null;
  lastCaptureAt = now;
  captureCount += 1;

  let summary: Record<string, unknown>;
  try {
    summary = await gatherSyncDiagnostics(facets, 50);
  } catch {
    return null;
  }

  return Sentry.withScope((scope) => {
    scope.setTag('report', 'sync-auto');
    scope.setTag('sync_outcome', facets.outcome ?? 'unknown');
    scope.setContext('sync', {
      status: facets.status,
      outcome: facets.outcome ?? null,
      pendingWrites: facets.pendingWrites ?? null,
      lastError: facets.lastError ?? null,
      syncingForMs: facets.syncingForMs ?? null,
      dbStats: summary.dbStats,
    });
    scope.addAttachment({
      filename: 'sync-diagnostics.json',
      data: JSON.stringify(summary),
      contentType: 'application/json',
    });
    return Sentry.captureMessage(`sync auto-diagnostic: ${facets.outcome ?? 'error'}`, 'warning');
  });
}
