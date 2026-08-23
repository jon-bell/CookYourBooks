// The synchronous half of the interaction-signal opt-out: a cache and its
// localStorage mirror. Deliberately free of any Supabase import — the network
// half lives in `prefsApi.ts`, so the enqueue gate (and its unit tests) never
// pull in a client that throws at module scope when unconfigured.
//
// Three layers overall, because the gate in capture.ts has to answer
// "recording?" SYNCHRONOUSLY and cannot await a round trip on every keystroke:
//
//   1. `profiles.share_interaction_signals` — the source of truth, and the
//      only one that binds: `record_search_events` / `record_suggestion_events`
//      read it server-side and drop the batch when it's false. So a stale
//      client can waste a request, but it cannot record against the user's
//      wishes. Read/written by `prefsApi.ts`.
//   2. The module cache below — what the synchronous gate actually reads.
//   3. A localStorage mirror — seeds the cache before the profile fetch
//      resolves, so a page load doesn't spend its first seconds capturing
//      under the wrong assumption. It is a cache, not the setting; clearing it
//      loses nothing but a round trip.

const MIRROR_KEY = 'cookyourbooks.signals.enabled.v1';

/** Unknown until the mirror is read or the profile resolves. */
let cached: boolean | undefined;

function readMirror(): boolean | undefined {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return undefined;
  } catch {
    // Locked-down webviews throw on localStorage. Fall through to the default.
    return undefined;
  }
}

/**
 * Synchronous answer for the enqueue gate. Defaults to ON (matching the
 * column default) when we've never heard otherwise: the server enforces the
 * real setting, so the worst case for a wrong guess here is a wasted request,
 * not a recorded event.
 */
export function signalsEnabled(): boolean {
  cached ??= readMirror();
  return cached ?? true;
}

/**
 * Record a value we've confirmed against the account. Called by `prefsApi.ts`
 * after a successful read or write — never speculatively, so the gate and the
 * server can't drift.
 */
export function applySignalsPref(enabled: boolean): void {
  cached = enabled;
  try {
    localStorage.setItem(MIRROR_KEY, enabled ? '1' : '0');
  } catch {
    // Nothing to do — we just pay a round trip on the next page load.
  }
}

/** Test seam: set the cache directly, bypassing the mirror. */
export function primeSignalsPref(enabled: boolean | undefined): void {
  cached = enabled;
}
