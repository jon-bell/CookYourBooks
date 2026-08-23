/**
 * In-memory ring buffer of what the user just did, so a bug report arrives with
 * the sequence that produced it instead of only a description of the symptom.
 *
 * Deliberately fed from two *global* sources rather than hand-instrumented call
 * sites — a trail is only useful if it's complete, and per-component `track()`
 * calls rot the moment someone adds a screen:
 *   * route changes, via the listener mounted in App.tsx;
 *   * clicks, via one delegated document listener (see `installClickTracking`).
 * `track()` exists for the handful of things neither of those can see (a search
 * that was actually run, a sync failure).
 *
 * Shape and cost mirror `local/syncLog.ts`. Unlike the sync log this one *is*
 * persisted, for one session, across reloads: "it broke, I reloaded, then I
 * reported it" is a common and important path, and an in-memory-only trail
 * would have thrown away everything that led up to the bug. The write happens
 * once on `pagehide` rather than per crumb, so the steady-state cost is nil.
 */

export type BreadcrumbKind = 'route' | 'click' | 'event';

export interface Breadcrumb {
  id: number;
  /** Epoch ms. Serialized as-is; the report renders deltas. */
  at: number;
  kind: BreadcrumbKind;
  /** Short human label: the path, the button text, the event name. */
  label: string;
  /** Optional small detail bag. Kept tiny — this is a trail, not a log. */
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 100;
/** Click labels can be a whole recipe title; enough to identify, not to bloat. */
const MAX_LABEL = 80;
const STORE_KEY = 'cookyourbooks.feedback.crumbs.v1';

let nextId = 1;
const buffer: Breadcrumb[] = [];
let restored = false;

/**
 * Fold in the previous page-load's trail, once. Lazy rather than at import time
 * so module evaluation order and non-browser contexts (unit tests) stay simple.
 */
function restoreOnce(): void {
  if (restored) return;
  restored = true;
  if (typeof sessionStorage === 'undefined') return;
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Breadcrumb[];
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    buffer.unshift(...parsed.slice(-MAX_ENTRIES));
    // Keep ids unique against the restored set.
    nextId = Math.max(nextId, ...parsed.map((c) => c.id + 1));
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  } catch {
    // Corrupt or private mode — an empty trail is a fine fallback.
  }
}

function persist(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(buffer));
  } catch {
    // Quota / private mode: the in-memory trail still works this session.
  }
}

function push(kind: BreadcrumbKind, label: string, data?: Record<string, unknown>): void {
  restoreOnce();
  const trimmed = label.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  if (!trimmed) return;
  buffer.push({ id: nextId++, at: Date.now(), kind, label: trimmed, data });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

/** Record a route change. Called by the App-level listener. */
export function trackRoute(path: string): void {
  // Collapse repeats so a re-render storm can't flood the trail.
  const last = buffer[buffer.length - 1];
  if (last?.kind === 'route' && last.label === path) return;
  push('route', path);
}

/** Record a named app event that neither routing nor clicks would show. */
export function track(name: string, data?: Record<string, unknown>): void {
  push('event', name, data);
}

export function getBreadcrumbs(): readonly Breadcrumb[] {
  restoreOnce();
  return buffer.slice();
}

export function clearBreadcrumbs(): void {
  buffer.length = 0;
  restored = true;
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Nothing to do; the in-memory buffer is already cleared.
  }
}

/**
 * Best-effort label for a clicked element: its accessible name, falling back to
 * visible text, then to a title/aria-label, then the tag. Walks up to the
 * nearest interactive ancestor so a click on a `<span>` inside a button still
 * reports the button.
 */
function describeTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest('button, a, [role="button"], input[type="submit"]');
  if (!el) return null;
  // First non-blank of: accessible name, visible text, tooltip.
  const candidates = [el.getAttribute('aria-label'), el.textContent, el.getAttribute('title')];
  const text = candidates.find((c) => typeof c === 'string' && c.trim() !== '') ?? '';
  const label = text.replace(/\s+/g, ' ').trim();
  const tag = el.tagName.toLowerCase();
  if (!label) return tag;
  return `${tag}: ${label}`;
}

/**
 * One delegated capture-phase listener for the whole app. Capture phase so a
 * handler calling stopPropagation still leaves a trace.
 */
export function installClickTracking(): () => void {
  if (typeof document === 'undefined') return () => {};
  restoreOnce();
  const onClick = (e: Event) => {
    const label = describeTarget(e.target);
    if (label) push('click', label);
  };
  // One write per page-load teardown, so a reload (or a crash-then-reload)
  // doesn't lose the run-up to the bug. Same hook useScrollRestoration uses.
  const onPageHide = () => persist();
  document.addEventListener('click', onClick, { capture: true, passive: true });
  window.addEventListener('pagehide', onPageHide);
  return () => {
    document.removeEventListener('click', onClick, { capture: true });
    window.removeEventListener('pagehide', onPageHide);
  };
}
