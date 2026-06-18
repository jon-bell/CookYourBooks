// Per-cycle data-transfer meter.
//
// The sync engine is the app's dominant network consumer, but until now
// we measured only durations + row counts — never bytes. This module
// accumulates request/response sizes for the *current* sync cycle so we
// can (a) attach byte totals to the Sentry `sync.cycle` span and (b)
// record a per-cycle row into `sync_transfer_events` for the user-facing
// /data-usage page.
//
// Mirrors the shape of db.ts's `beginDbStatsWindow` / `readDbStats`: a
// single global window that the leader's `cycle()` opens at the start and
// reads at the end. The instrumented `fetch` in supabase.ts calls
// `recordTransfer` for every request while a window is open; it's a no-op
// otherwise, so non-cycle traffic (and follower tabs) cost nothing.
//
// Bytes are best-effort: we read `Content-Length` for responses (this is
// the on-the-wire size — already gzip-compressed when the gateway gzips,
// which is exactly what we want to report) and the serialized length of
// the request body. Responses without a Content-Length (rare for
// PostgREST / edge functions) simply contribute 0 down-bytes rather than
// our paying to clone + drain the stream.

export interface PhaseTransfer {
  bytesDown: number;
  bytesUp: number;
  requests: number;
  rows: number;
}

export interface MeterSnapshot {
  phases: Record<string, PhaseTransfer>;
  totalDown: number;
  totalUp: number;
  totalRequests: number;
}

let active = false;
let currentPhase = 'other';
const phases = new Map<string, PhaseTransfer>();

function bucket(name: string): PhaseTransfer {
  let p = phases.get(name);
  if (!p) {
    p = { bytesDown: 0, bytesUp: 0, requests: 0, rows: 0 };
    phases.set(name, p);
  }
  return p;
}

/** Open a fresh measurement window (called at the top of each sync cycle). */
export function beginMeterWindow(): void {
  active = true;
  currentPhase = 'other';
  phases.clear();
}

/** Close the window so subsequent traffic (incl. our own metrics flush) isn't counted. */
export function endMeterWindow(): void {
  active = false;
}

export function isMetering(): boolean {
  return active;
}

/**
 * Tag subsequent requests with a phase label until the next call. The
 * sync engine sets this at phase boundaries ('collections', 'recipes',
 * 'snapshot_meta', 'snapshot_bodies', 'push', …) so /data-usage can break
 * the cycle down by where the bytes went.
 */
export function meterPhase(name: string): void {
  if (active) currentPhase = name;
}

/** Called by the instrumented fetch for every request while a window is open. */
export function recordTransfer(bytesDown: number, bytesUp: number): void {
  if (!active) return;
  const p = bucket(currentPhase);
  p.bytesDown += bytesDown;
  p.bytesUp += bytesUp;
  p.requests += 1;
}

/** Attribute a row count to the current phase (bytes don't tell us row counts). */
export function meterRows(rows: number): void {
  if (active && rows > 0) bucket(currentPhase).rows += rows;
}

export function readMeter(): MeterSnapshot {
  const out: Record<string, PhaseTransfer> = {};
  let totalDown = 0;
  let totalUp = 0;
  let totalRequests = 0;
  for (const [name, p] of phases) {
    out[name] = { ...p };
    totalDown += p.bytesDown;
    totalUp += p.bytesUp;
    totalRequests += p.requests;
  }
  return { phases: out, totalDown, totalUp, totalRequests };
}
