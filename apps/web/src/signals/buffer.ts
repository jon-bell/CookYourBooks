// The pure buffering core behind interaction-signal capture: batching, the
// opt-out gate, the flush lifecycle. Transport is injected, so this module
// imports no Supabase client — which is what lets it be unit-tested in a job
// that has no VITE_SUPABASE_* (supabase.ts throws at module scope by design).
// `capture.ts` is the thin shell that binds it to the real RPCs.
//
// Three rules this exists to enforce, so no call site has to remember them:
//
//   1. NEVER load-bearing. Capture runs off to the side of the user's action;
//      a failed flush is swallowed. Nothing here is allowed to reject, block a
//      render, or turn a working search into an error.
//   2. Batched. Events accumulate and flush on a timer / at a cap / when the
//      page goes away, so a burst of typing is one round trip, not eight.
//   3. Gated once, centrally. The opt-out is checked at enqueue time in one
//      place — call sites call `recordSearchEvent` unconditionally. This gate
//      is a courtesy (don't put opted-out data on the wire at all); the
//      binding enforcement is server-side in the write RPCs.

import type { SearchEventPayload, SuggestionEventPayload } from './api.js';
import { signalsEnabled } from './prefs.js';

/** Coalescing window. Long enough that scrolling a result list and clicking
 *  through rides in one request; short enough that a user who closes the tab
 *  right after searching usually still gets flushed by the pagehide hook. */
const FLUSH_DELAY_MS = 4_000;

/** Hard cap per kind. A pathological session (or a bug) drops its oldest
 *  events rather than growing the buffer without bound. */
const MAX_BUFFERED = 40;

/** Keys remembered per instance for `recordOnce`, bounded so a huge library
 *  can't grow the set forever. */
const MAX_SEEN_ONCE = 2_000;

export interface SignalTransport {
  search(events: readonly SearchEventPayload[]): Promise<void>;
  suggestion(events: readonly SuggestionEventPayload[]): Promise<void>;
}

// Function-typed properties, not method shorthand: these are closures with no
// `this`, and callers destructure them off the instance (capture.ts does).
// Method shorthand would trip `@typescript-eslint/unbound-method` at every
// such call site for a hazard that doesn't exist here.
export interface SignalCapture {
  recordSearchEvent: (event: SearchEventPayload) => void;
  recordSuggestionEvent: (event: SuggestionEventPayload) => void;
  flushSignals: () => Promise<void>;
  recordOnce: (key: string) => boolean;
}

/** Mint the id that ties a search to the result the user opens from it. */
export function newQueryId(): string {
  return crypto.randomUUID();
}

/**
 * Build a capture instance over `transport`. A factory rather than a module
 * singleton so each test gets its own buffers and `seenOnce` set — no reset
 * seam to remember, and no cross-test bleed.
 */
export function createSignalCapture(transport: SignalTransport): SignalCapture {
  let searchBuf: SearchEventPayload[] = [];
  let suggestionBuf: SuggestionEventPayload[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let unloadHooked = false;
  const seenOnce = new Set<string>();

  function push<T>(buf: T[], event: T): void {
    buf.push(event);
    // Drop from the FRONT: the newest events are the ones whose context the
    // rest of the session can still explain.
    if (buf.length > MAX_BUFFERED) buf.splice(0, buf.length - MAX_BUFFERED);
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

  function scheduleFlush(): void {
    hookUnloadOnce();
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushSignals();
    }, FLUSH_DELAY_MS);
  }

  /**
   * Send everything buffered. Resolves once both posts have settled; never
   * rejects. The buffers are drained BEFORE the awaits so a slow flush racing
   * a new event can't send it twice — a dropped signal is cheap, a duplicated
   * one quietly biases whatever we train on it.
   */
  async function flushSignals(): Promise<void> {
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
    // Failures are intentionally not retried and not re-buffered. These rows
    // are a statistical sample for training, not an audit trail; retrying
    // would over-represent whoever has a flaky connection.
  }

  return {
    /** Enqueue a search or result-open event. No-op when opted out. */
    recordSearchEvent(event) {
      if (!signalsEnabled()) return;
      push(searchBuf, event);
      scheduleFlush();
    },

    /** Enqueue a suggestion accept/correct/clear. No-op when opted out. */
    recordSuggestionEvent(event) {
      if (!signalsEnabled()) return;
      push(suggestionBuf, event);
      scheduleFlush();
    },

    flushSignals,

    /**
     * True the first time a given key is passed to this instance, false after.
     * Used for impression-style signals (an auto-match the user never touched)
     * that would otherwise re-fire on every render of the same recipe and
     * drown the far rarer correction events they need comparing against.
     */
    recordOnce(key) {
      if (seenOnce.has(key)) return false;
      // At the cap, stop remembering rather than evicting: a false "already
      // seen" loses one impression, a false "new" would let a hot key re-fire
      // forever.
      if (seenOnce.size >= MAX_SEEN_ONCE) return false;
      seenOnce.add(key);
      return true;
    },
  };
}
