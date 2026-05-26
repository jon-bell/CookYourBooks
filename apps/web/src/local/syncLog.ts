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

export function logSync(
  level: SyncLogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  buffer.push({ id: nextId++, at: Date.now(), level, message, data });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  for (const fn of subscribers) fn();
  // Mirror to console at the matching level so devtools sees them too.
  const tag = '[sync]';
  if (level === 'error') console.error(tag, message, data ?? '');
  else if (level === 'warn') console.warn(tag, message, data ?? '');
  else console.info(tag, message, data ?? '');
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
