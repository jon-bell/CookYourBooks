// Buffered, best-effort capture of interaction signals.
//
// Three rules this module exists to enforce, so no call site has to remember
// them:
//
//   1. NEVER load-bearing. Capture runs off to the side of the user's action;
//      a failed flush is swallowed. Nothing here is allowed to reject, block a
//      render, or turn a working search into an error.
//   2. Batched. Events accumulate and flush on a timer / at a cap / when the
//      page goes away, so a burst of typing is one round trip, not eight.
//   3. Gated once, centrally. The opt-out is checked at enqueue time in one
//      place — call sites call `recordSearchEvent` unconditionally.

import {
  postSearchEvents,
  postSuggestionEvents,
  type SearchEventPayload,
  type SuggestionEventPayload,
} from './api.js';
import { isSignalsOptedOut } from './prefs.js';

/** Coalescing window. Long enough that scrolling a result list and clicking
 *  through rides in one request; short enough that a user who closes the tab
 *  right after searching usually still gets flushed by the pagehide hook. */
const FLUSH_DELAY_MS = 4_000;

/** Hard cap per kind. A pathological session (or a bug) drops its oldest
 *  events rather than growing the buffer without bound. */
const MAX_BUFFERED = 40;

/** Swappable transport so unit tests can assert on payloads without a network
 *  or a Supabase client. Production wiring is the module default. */
export interface SignalTransport {
  search(events: readonly SearchEventPayload[]): Promise<void>;
  suggestion(events: readonly SuggestionEventPayload[]): Promise<void>;
}

const defaultTransport: SignalTransport = {
  search: postSearchEvents,
  suggestion: postSuggestionEvents,
};

let transport: SignalTransport = defaultTransport;
let searchBuf: SearchEventPayload[] = [];
let suggestionBuf: SuggestionEventPayload[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let unloadHooked = false;
/** Keys already reported this page-load, for the once-per-session impressions
 *  (see `recordOnce`). Bounded so a huge library can't grow it forever. */
const seenOnce = new Set<string>();
const MAX_SEEN_ONCE = 2_000;

/** Test seam: swap the transport, and (with no argument) restore the real one. */
export function setSignalTransport(next?: SignalTransport): void {
  transport = next ?? defaultTransport;
}

/** Test seam: drop buffered state between cases. */
export function resetSignalsForTest(): void {
  searchBuf = [];
  suggestionBuf = [];
  seenOnce.clear();
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
}

/** Mint the id that ties a search to the result the user opens from it. */
export function newQueryId(): string {
  return crypto.randomUUID();
}

/**
 * True the first time a given key is passed in this page-load, false after.
 * Used for impression-style signals (an auto-match the user never touched)
 * that would otherwise re-fire on every render of the same recipe and drown
 * the far rarer correction events they need to be compared against.
 */
export function recordOnce(key: string): boolean {
  if (seenOnce.has(key)) return false;
  // At the cap, stop remembering rather than evicting: a false "already seen"
  // loses one impression, a false "new" would let a hot key re-fire forever.
  if (seenOnce.size >= MAX_SEEN_ONCE) return false;
  seenOnce.add(key);
  return true;
}

function scheduleFlush(): void {
  hookUnloadOnce();
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushSignals();
  }, FLUSH_DELAY_MS);
}

// A tab closing / backgrounding is the common way a session ends, and on iOS
// it's often the ONLY signal — `pagehide` fires where `beforeunload` doesn't.
// `visibilitychange` covers a backgrounded PWA that never unloads at all.
function hookUnloadOnce(): void {
  if (unloadHooked || typeof window === 'undefined') return;
  unloadHooked = true;
  const onAway = () => {
    void flushSignals();
  };
  window.addEventListener('pagehide', onAway);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onAway();
  });
}

function push<T>(buf: T[], event: T): void {
  buf.push(event);
  // Drop from the FRONT: the newest events are the ones whose context the
  // rest of the session can still explain.
  if (buf.length > MAX_BUFFERED) buf.splice(0, buf.length - MAX_BUFFERED);
}

/** Enqueue a search or result-open event. No-op when opted out. */
export function recordSearchEvent(event: SearchEventPayload): void {
  if (isSignalsOptedOut()) return;
  push(searchBuf, event);
  scheduleFlush();
}

/** Enqueue a suggestion accept/correct/clear. No-op when opted out. */
export function recordSuggestionEvent(event: SuggestionEventPayload): void {
  if (isSignalsOptedOut()) return;
  push(suggestionBuf, event);
  scheduleFlush();
}

/**
 * Send everything buffered. Resolves once both posts have settled; never
 * rejects. The buffers are drained BEFORE the awaits so a slow flush racing a
 * new event can't send it twice — a dropped signal is cheap, a duplicated one
 * quietly biases whatever we train on it.
 */
export async function flushSignals(): Promise<void> {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const searches = searchBuf;
  const suggestions = suggestionBuf;
  searchBuf = [];
  suggestionBuf = [];
  if (searches.length === 0 && suggestions.length === 0) return;
  await Promise.allSettled([
    searches.length > 0 ? transport.search(searches) : Promise.resolve(),
    suggestions.length > 0 ? transport.suggestion(suggestions) : Promise.resolve(),
  ]);
  // Failures are intentionally not retried and not re-buffered. These rows are
  // a statistical sample for training, not an audit trail; retrying would
  // over-represent whoever has a flaky connection.
}
