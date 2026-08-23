/**
 * Ring buffer of recent errors and warnings, so an error report carries what
 * the console actually said rather than the user's paraphrase of it.
 *
 * Three sources, because each catches things the others miss:
 *   * `console.error` / `console.warn` — including everything the sync log
 *     already mirrors there, plus React's own warnings;
 *   * `window.onerror` — uncaught exceptions;
 *   * `unhandledrejection` — the failure mode a local-first app hits most.
 *
 * The console patch delegates to the original every time, so behavior (and
 * devtools' own source links) is unchanged; this only observes.
 */

export interface ConsoleEntry {
  at: number;
  level: 'error' | 'warn';
  text: string;
}

const MAX_ENTRIES = 60;
/** One stack trace is plenty; a whole serialized object is not. */
const MAX_TEXT = 600;

const buffer: ConsoleEntry[] = [];
let installed = false;

function record(level: 'error' | 'warn', parts: unknown[]): void {
  let text: string;
  try {
    text = parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p instanceof Error) return `${p.name}: ${p.message}\n${p.stack ?? ''}`;
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      })
      .join(' ');
  } catch {
    text = '(unserializable)';
  }
  buffer.push({ at: Date.now(), level, text: text.slice(0, MAX_TEXT) });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

export function getConsoleTail(): readonly ConsoleEntry[] {
  return buffer.slice();
}

export function clearConsoleTail(): void {
  buffer.length = 0;
}

/** Idempotent; returns a teardown for tests. */
export function installConsoleCapture(): () => void {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;

  /* eslint-disable no-console */
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => {
    record('error', args);
    origError.apply(console, args as never[]);
  };
  console.warn = (...args: unknown[]) => {
    record('warn', args);
    origWarn.apply(console, args as never[]);
  };
  /* eslint-enable no-console */

  const onError = (e: ErrorEvent) => {
    record('error', [`uncaught: ${e.message}`, `${e.filename}:${e.lineno}:${e.colno}`]);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    record('error', ['unhandledrejection:', e.reason]);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    /* eslint-disable no-console */
    console.error = origError;
    console.warn = origWarn;
    /* eslint-enable no-console */
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    installed = false;
  };
}
