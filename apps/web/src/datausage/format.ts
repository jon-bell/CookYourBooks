// Pure formatting helpers for the Data Usage report. Kept framework-free so
// they're unit-testable in isolation (mirrors cost/format.ts).

/**
 * Humanize a byte count into B / KB / MB / GB / TB (binary, 1024-based). Picks
 * the largest unit where the value is >= 1, with 0–2 decimals so small
 * transfers don't collapse to "0 MB". Guards nullish.
 */
export function formatBytes(bytes: number): string {
  const n = bytes ?? 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** exp;
  // Whole bytes show no decimals; otherwise 2 sig-ish decimals, trimmed.
  const decimals = exp === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[exp]}`;
}

/**
 * Humanize a millisecond duration. Sub-second stays in ms; seconds get 1–2
 * decimals; a minute or more switches to "Xm Ys". Guards nullish.
 */
export function formatDuration(ms: number): string {
  const n = ms ?? 0;
  if (n <= 0) return '0 ms';
  if (n < 1000) return `${Math.round(n)} ms`;
  const seconds = n / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins}m ${rem}s`;
}

/** Thousands-separated integer (rows / requests). */
export function formatCount(n: number): string {
  return (n ?? 0).toLocaleString();
}

/** Human label for a sync direction. */
export const DIRECTION_LABEL: Record<string, string> = {
  pull: 'Pull (download)',
  push: 'Push (upload)',
};

export function directionLabel(direction: string): string {
  return DIRECTION_LABEL[direction] ?? direction;
}

/** Human label for a sync phase tag. */
export const PHASE_LABEL: Record<string, string> = {
  recipes: 'Recipes',
  collections: 'Collections',
  snapshot_meta: 'Snapshot metadata',
  snapshot_bodies: 'Snapshot bodies',
  imports: 'Imports',
  push: 'Push',
  total: 'Total',
};

export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase;
}
