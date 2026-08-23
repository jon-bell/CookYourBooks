/**
 * Assembles the evidence that travels with a feedback report.
 *
 * Everything here is already being collected for other reasons — the breadcrumb
 * trail, the sync log, the console tail, the search timing breakdown — so
 * filing a report is a read, not a measurement. Pure and framework-free so it
 * can be unit tested without a DOM harness beyond the globals it reads.
 */

import { getSyncLog, type SyncLogEntry } from '../local/syncLog.js';
import { getLastSearchTimings, type SearchTimings } from '../search/perf.js';
import { getSentryStatus } from '../sentry.js';
import { type Breadcrumb, getBreadcrumbs } from './breadcrumbs.js';
import { type ConsoleEntry, getConsoleTail } from './consoleTail.js';

export type FeedbackKind = 'bug' | 'feature';

export interface DeviceContext {
  /** Build id — `VITE_SENTRY_RELEASE`. Null in dev, which is itself a signal. */
  release: string | null;
  platform: 'capacitor-ios' | 'capacitor-android' | 'web';
  environment: string;
  online: boolean;
  userAgent: string;
  language: string;
  timeZone: string | null;
  viewport: { width: number; height: number; dpr: number };
  /** Local wall-clock at submit time, for lining up against server timestamps. */
  localTime: string;
}

export interface FeedbackPayload {
  breadcrumbs: readonly Breadcrumb[];
  syncLog: readonly SyncLogEntry[];
  consoleTail: readonly ConsoleEntry[];
  device: DeviceContext;
  /** Most recent search timing breakdown, when the session ran one. */
  search?: SearchTimings;
}

/** The server caps the payload at 256 KB; stay clear of it with room to spare. */
const MAX_PAYLOAD_BYTES = 180_000;
const SYNC_LOG_TAIL = 150;

export function collectDeviceContext(): DeviceContext {
  const sentry = getSentryStatus();
  let timeZone: string | null = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Locked-down runtimes can throw here; the field is a nicety.
  }
  return {
    release: sentry.release,
    platform: sentry.platform,
    environment: sentry.environment,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    language: typeof navigator === 'undefined' ? '' : navigator.language,
    timeZone,
    viewport: {
      width: typeof window === 'undefined' ? 0 : window.innerWidth,
      height: typeof window === 'undefined' ? 0 : window.innerHeight,
      dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    },
    localTime: new Date().toISOString(),
  };
}

/**
 * Snapshot every evidence source. Trims the largest sections first if the
 * result would breach the server's size guard, so an unusually chatty session
 * degrades the report instead of failing the submit.
 */
export function collectFeedbackPayload(): FeedbackPayload {
  const payload: FeedbackPayload = {
    breadcrumbs: getBreadcrumbs(),
    syncLog: getSyncLog().slice(-SYNC_LOG_TAIL),
    consoleTail: getConsoleTail(),
    device: collectDeviceContext(),
    search: getLastSearchTimings(),
  };
  return trimToLimit(payload);
}

/** Rough byte size of the JSON encoding. */
export function payloadSize(payload: FeedbackPayload): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return 0;
  }
}

/**
 * Drop the bulkiest sections until the payload fits, in increasing order of
 * value to a bug report: sync log first (longest and most repetitive), then the
 * console tail, then the older half of the breadcrumb trail. The device context
 * and the newest breadcrumbs always survive.
 */
export function trimToLimit(payload: FeedbackPayload, limit = MAX_PAYLOAD_BYTES): FeedbackPayload {
  let out = payload;
  if (payloadSize(out) <= limit) return out;

  for (const tail of [50, 20, 0]) {
    // `slice(-0)` is `slice(0)` — the whole array — so empty is a special case.
    out = { ...out, syncLog: tail === 0 ? [] : payload.syncLog.slice(-tail) };
    if (payloadSize(out) <= limit) return out;
  }
  out = { ...out, consoleTail: out.consoleTail.slice(-10) };
  if (payloadSize(out) <= limit) return out;

  out = { ...out, consoleTail: [], breadcrumbs: out.breadcrumbs.slice(-25) };
  return out;
}
