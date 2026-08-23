// Timing instrumentation for the /search pipeline.
//
// Search had two prior optimization passes (SQL-backed literal search,
// cosine moved off-thread) landed without any way to measure which stage
// actually dominated. This module fixes that: every query records a
// per-stage breakdown, cheaply enough to leave on in production
// (`performance.now()` is nanoseconds; the object churn is one small
// record per completed query, not per keystroke).
//
// Two consumers:
//   * the power-user console mirror, behind the existing
//     `cookyourbooks.sync.consoleMirror` flag — same flag the sync log
//     and `useSearch`'s searchDebug already use, so there's one switch;
//   * the feedback report payload, which attaches the most recent
//     breakdown so a "search is slow" report arrives with numbers
//     instead of an adjective.

/** Per-stage durations in ms, keyed by stage name. Stages measured inside a
 *  `Promise.all` overlap in wall-clock terms — that's intentional and worth
 *  seeing, since the point is which stage is long, not how they sum. */
export type SearchStages = Record<string, number>;

export interface SearchTimings {
  /** The query text. Kept so a stale reading is obviously stale. */
  q: string;
  /** Wall-clock ms from timer creation to `finish()`. */
  total: number;
  stages: SearchStages;
  /** Which path ran: hybrid (literal + semantic) or literal-only. */
  mode?: 'semantic' | 'substring';
  /** How many vectors the cosine pass scanned. */
  vectors?: number;
  /** How many hits were returned to the page. */
  hits?: number;
  /** Epoch ms, so a report can say how long ago this was measured. */
  at: number;
}

const DEBUG_FLAG = 'cookyourbooks.sync.consoleMirror';

function debugEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(DEBUG_FLAG) === '1';
  } catch {
    // localStorage throws in locked-down webviews; diagnostics are best-effort.
    return false;
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

let last: SearchTimings | undefined;

/** The most recent completed search's breakdown, or undefined if none has run
 *  this session. Read by the feedback report payload. */
export function getLastSearchTimings(): SearchTimings | undefined {
  return last;
}

/** Test hatch — lets a unit test assert on a clean slate. */
export function resetSearchTimings(): void {
  last = undefined;
}

export interface SearchTimer {
  /** Time an async stage. Safe to use on concurrent stages. */
  track<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Record a stage measured by the caller (e.g. a synchronous loop). */
  mark(name: string, ms: number): void;
  /** Time a synchronous stage. */
  sync<T>(name: string, fn: () => T): T;
  /** Record how many vectors the cosine pass scanned. */
  vectors(n: number): void;
  finish(extra?: Pick<SearchTimings, 'mode' | 'vectors' | 'hits'>): SearchTimings;
}

/**
 * Start timing one search. Call `finish()` exactly once; the resulting
 * breakdown replaces `getLastSearchTimings()` and is console-mirrored when
 * the debug flag is on.
 */
export function createSearchTimer(q: string): SearchTimer {
  const t0 = performance.now();
  const stages: SearchStages = {};
  let vectorCount: number | undefined;

  return {
    async track<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        stages[name] = round(performance.now() - start);
      }
    },
    sync<T>(name: string, fn: () => T): T {
      const start = performance.now();
      try {
        return fn();
      } finally {
        stages[name] = round(performance.now() - start);
      }
    },
    mark(name: string, ms: number): void {
      stages[name] = round(ms);
    },
    vectors(n: number): void {
      vectorCount = n;
    },
    finish(extra): SearchTimings {
      const timings: SearchTimings = {
        q,
        total: round(performance.now() - t0),
        stages,
        at: Date.now(),
        vectors: vectorCount,
        ...extra,
      };
      last = timings;
      if (debugEnabled()) {
        // eslint-disable-next-line no-console
        console.debug('[search:perf]', timings);
      }
      return timings;
    },
  };
}

/**
 * A timer that measures nothing and records nothing. Lets the pipeline take a
 * `SearchTimer` unconditionally instead of guarding every stage with a
 * ternary, for the paths that aren't the timed entry point.
 */
export function nullSearchTimer(): SearchTimer {
  return {
    track: <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    sync: <T>(_name: string, fn: () => T): T => fn(),
    mark: (): void => {},
    vectors: (): void => {},
    finish: (extra): SearchTimings => ({ q: '', total: 0, stages: {}, at: Date.now(), ...extra }),
  };
}
