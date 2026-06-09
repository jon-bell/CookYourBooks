// Pure formatting helpers for the Activity feed. Kept framework-free so they're
// unit-testable in isolation (mirrors cost/format.ts).

import type { BatchJobRow, JobKind, JobStatus } from './api.js';

/** Human label per job kind. */
export const KIND_LABEL: Record<JobKind, string> = {
  ocr: 'OCR import',
  bakeoff: 'Model bake-off',
  rewrite: 'Step rewrite',
  remix: 'Recipe Remix',
  embedding: 'Embedding',
  cover: 'Cover image',
};

export function jobKindLabel(kind: string): string {
  return KIND_LABEL[kind as JobKind] ?? kind;
}

/** Human label per normalized status. */
export const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status as JobStatus] ?? status;
}

/** Tailwind classes for the status pill, colour-coded by outcome. */
export function statusPillClass(status: string): string {
  switch (status) {
    case 'done':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300';
    case 'running':
      return 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300';
    case 'pending':
    default:
      return 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300';
  }
}

/** Queued or actively running — i.e. the user may still be waiting on it. */
export function isInFlight(status: string): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * Feed order: in-flight jobs first (the user is waiting on them), then the
 * rest; within each group, newest activity first. ISO `updated_at` strings sort
 * lexicographically == chronologically. Pure + non-mutating so it's testable.
 */
export function sortJobsForFeed(rows: readonly BatchJobRow[]): BatchJobRow[] {
  return [...rows].sort((a, b) => {
    const af = isInFlight(a.status) ? 0 : 1;
    const bf = isInFlight(b.status) ? 0 : 1;
    if (af !== bf) return af - bf;
    return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
  });
}
