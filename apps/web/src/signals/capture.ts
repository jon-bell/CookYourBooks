// The app's interaction-signal capture instance: the pure buffering core from
// `buffer.ts` bound to the real write RPCs. Every call site imports from here,
// so the wiring is static and there is exactly one buffer in the app.
//
// The split exists so the buffering rules can be unit-tested without dragging
// in `api.ts` → `supabase.ts`, which throws at module scope when
// VITE_SUPABASE_* is unset — the state the unit-test job runs in.

import { postSearchEvents, postSuggestionEvents } from './api.js';
import { createSignalCapture } from './buffer.js';

export { newQueryId } from './buffer.js';
export type { SignalCapture, SignalTransport } from './buffer.js';

const capture = createSignalCapture({
  search: postSearchEvents,
  suggestion: postSuggestionEvents,
});

export const { recordSearchEvent, recordSuggestionEvent, flushSignals, recordOnce } = capture;
