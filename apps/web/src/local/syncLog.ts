/**
 * Tiny in-memory ring buffer for sync-cycle events. Lets the debug
 * dialog show what the engine is doing right now (which entry it's
 * pushing, how long each phase took, where it died). Not persisted —
 * a page reload clears the buffer.
 */

export type SyncLogLevel = 'info' | 'warn' | 'error';

export interface SyncLogEntry {
  id: number;
  at: number;
  level: SyncLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 500;
let nextId = 1;
const buffer: SyncLogEntry[] = [];
const subscribers = new Set<() => void>();

/**
 * Console mirroring lets devtools watch sync events live, but the
 * synchronous IPC under remote-attached Safari (iPad) or Playwright
 * adds up — every `logSync` call pays the IPC cost. Errors/warns are
 * cheap and always-on; info-level is gated behind a localStorage
 * flag so a power user can opt in (set `cookyourbooks.sync.consoleMirror`
 * to "1") without paying the cost by default.
 */
const INFO_MIRROR_KEY = 'cookyourbooks.sync.consoleMirror';
let infoMirrorEnabled: boolean | undefined;
function shouldMirrorInfo(): boolean {
  if (infoMirrorEnabled !== undefined) return infoMirrorEnabled;
  if (typeof localStorage === 'undefined') {
    infoMirrorEnabled = false;
    return false;
  }
  try {
    infoMirrorEnabled = localStorage.getItem(INFO_MIRROR_KEY) === '1';
  } catch {
    infoMirrorEnabled = false;
  }
  return infoMirrorEnabled;
}

export function logSync(
  level: SyncLogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  buffer.push({ id: nextId++, at: Date.now(), level, message, data });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  for (const fn of subscribers) fn();
  const tag = '[sync]';
  if (level === 'error') console.error(tag, message, data ?? '');
  else if (level === 'warn') console.warn(tag, message, data ?? '');
  else if (shouldMirrorInfo()) console.info(tag, message, data ?? '');
}

// Expose the buffer on window so Playwright perf tests can read timing
// breakdowns ("pull recipes: 87 rows in Xms") without scraping the
// diagnostics dialog. Cheap — just a getter — so always on.
if (typeof window !== 'undefined') {
  (window as unknown as { __cybSyncLog?: () => readonly SyncLogEntry[] }).__cybSyncLog =
    () => buffer.slice();
}

export function getSyncLog(): readonly SyncLogEntry[] {
  return buffer.slice();
}

export function clearSyncLog(): void {
  buffer.length = 0;
  for (const fn of subscribers) fn();
}

export function subscribeSyncLog(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
