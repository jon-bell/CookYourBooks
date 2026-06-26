import { useEffect, useMemo } from 'react';

import { useAuth } from '../auth/AuthProvider.js';
import { useSync } from '../local/SyncProvider.js';
import { Sentry } from '../sentry.js';
import { COOKING_FLAVOR_LINES, interleaveLines } from './loadingLines.js';
import { useRotatingLine } from './useRotatingLine.js';

/** Loads shorter than this are never reported — keeps cache hits and
 *  StrictMode double-mounts out of Sentry entirely. */
const LOAD_REPORT_THRESHOLD_MS = 300;

/**
 * Reports how long a loading placeholder was on screen as a `ui.load` span,
 * created retroactively at unmount (same span-attribute style as the
 * sync.cycle spans in SyncProvider). The threshold gates span creation, so
 * fast loads cost nothing; Playwright runs are already excluded by the
 * navigator.webdriver guard in initSentry.
 */
function useLoadTelemetry(surface: string, report: boolean): void {
  useEffect(() => {
    if (!report) return;
    const start = Date.now();
    return () => {
      const ms = Date.now() - start;
      if (ms < LOAD_REPORT_THRESHOLD_MS) return;
      try {
        const span = Sentry.startInactiveSpan({
          op: 'ui.load',
          name: `page.${surface}`,
          startTime: start / 1000,
          forceTransaction: true,
          attributes: {
            'load.surface': surface,
            'load.duration_ms': ms,
            'load.path': window.location.pathname,
          },
        });
        span.end((start + ms) / 1000);
      } catch {
        /* telemetry must never break the UI */
      }
    };
  }, [surface, report]);
}

/**
 * The one loading placeholder for every page/section. Static "Loading…" lead
 * (stable for tests/screen readers) plus a rotating sub-line that interleaves
 * real status (sync phase, caller-supplied hints) with cooking-flavored
 * SimCity-style lines. Also measures how long it was visible (see
 * {@link useLoadTelemetry}).
 *
 * Use `size="inline"` for small widgets (dropdowns, side panels);
 * `report={false}` for sub-second UI where telemetry is just noise.
 */
export function LoadingState({
  surface,
  hints,
  size = 'block',
  report = true,
}: {
  /** Telemetry name + testid suffix, e.g. 'library' → data-testid="loading-library". */
  surface: string;
  /** Page-specific informational lines mixed into the rotation. */
  hints?: readonly string[];
  size?: 'block' | 'inline';
  report?: boolean;
}) {
  const { status, hydrated } = useSync();
  const { user } = useAuth();
  useLoadTelemetry(surface, report);

  const lines = useMemo(() => {
    const info: string[] = [];
    // Sync-phase lines only make sense for signed-in users — anon surfaces
    // (Discover, shared recipes) describe themselves via `hints`.
    if (user) {
      if (status === 'initializing') info.push('Opening your local library…');
      else if (status === 'syncing' || !hydrated) info.push('Fetching from the server…');
      if (status === 'offline') info.push('Offline — showing what’s cached on this device…');
    }
    if (hints) info.push(...hints);
    return interleaveLines(info, COOKING_FLAVOR_LINES);
  }, [user, status, hydrated, hints]);

  const line = useRotatingLine(lines);

  if (size === 'inline') {
    return (
      <span
        role="status"
        aria-live="polite"
        data-testid={`loading-${surface}`}
        className="text-sm text-stone-500 dark:text-stone-400"
      >
        Loading…
      </span>
    );
  }

  return (
    <div role="status" aria-live="polite" data-testid={`loading-${surface}`} className="py-2">
      <p className="text-stone-500 dark:text-stone-400">Loading…</p>
      {line && (
        <p className="mt-1 text-xs italic text-stone-400 dark:text-stone-500" aria-hidden>
          {line}
        </p>
      )}
    </div>
  );
}
