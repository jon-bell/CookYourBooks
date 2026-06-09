import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen blocking overlay used by the first-sync and schema-upgrade
 * popups. Presentational only — callers decide when to show it and what to
 * say. Honors prefers-reduced-motion (no shimmer / no line rotation) and dark
 * mode.
 */
export function LoadingOverlay({
  title,
  subtitle,
  step,
  progress,
  lines,
  rotateMs = 2500,
  error,
  onRetry,
  testId,
}: {
  title: string;
  subtitle?: string;
  step?: string | null;
  /** Determinate progress; omit for an indeterminate shimmer. */
  progress?: { processed: number; total: number } | null;
  /** Rotating flavor/status lines shown under the step. */
  lines?: string[];
  rotateMs?: number;
  error?: string | null;
  onRetry?: () => void;
  testId?: string;
}) {
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [lineIdx, setLineIdx] = useState(0);
  const lineCount = lines?.length ?? 0;
  // Pick a stable random starting line per mount so repeat visits differ.
  const start = useRef(lineCount > 0 ? Math.floor(Math.random() * lineCount) : 0);
  useEffect(() => {
    if (reducedMotion || lineCount <= 1) return;
    const t = setInterval(() => setLineIdx((i) => i + 1), rotateMs);
    return () => clearInterval(t);
  }, [reducedMotion, lineCount, rotateMs]);

  const flavor =
    lineCount > 0 ? lines![(start.current + lineIdx) % lineCount] : undefined;

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
    >
      <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-6 shadow-xl dark:border-stone-700 dark:bg-stone-900">
        {/* Intentionally NOT a heading element: a heading whose name contains
            "your library" collides with the many getByRole('heading', { name:
            'Your library' }) assertions/fixtures while this overlay is briefly
            up during first sync. The dialog's aria-label already names it. */}
        <div className="text-base font-semibold text-stone-900 dark:text-stone-100">{title}</div>
        {subtitle && (
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{subtitle}</p>
        )}

        {!error && (
          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
              {pct != null ? (
                <div
                  className="h-full rounded-full bg-stone-800 transition-[width] duration-300 dark:bg-stone-200"
                  style={{ width: `${pct}%` }}
                  data-testid="overlay-progress"
                />
              ) : (
                <div
                  className={`h-full w-1/3 rounded-full bg-stone-800 dark:bg-stone-200 ${
                    reducedMotion ? '' : 'animate-pulse'
                  }`}
                />
              )}
            </div>
            {(step || pct != null) && (
              <p className="mt-3 text-sm text-stone-700 dark:text-stone-300">
                {step}
                {pct != null && (
                  <span className="ml-1 tabular-nums text-stone-400">
                    {progress!.processed.toLocaleString()} / {progress!.total.toLocaleString()}
                  </span>
                )}
              </p>
            )}
            {flavor && (
              <p
                className="mt-1 text-xs italic text-stone-400 dark:text-stone-500"
                aria-hidden
                data-testid="overlay-flavor"
              >
                {flavor}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4">
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            {onRetry && (
              <button
                onClick={onRetry}
                className="mt-3 rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
              >
                Retry
              </button>
            )}
            <p className="mt-2 text-xs text-stone-400">Still working on it — you can keep waiting too.</p>
          </div>
        )}
      </div>
    </div>
  );
}
