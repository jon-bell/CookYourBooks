import type { ImportItem, ImportItemStatus } from './model.js';

/** Matches `LEASE_SECONDS` in the import-worker Edge Function. */
export const OCR_LEASE_MS = 300_000;

export function isOcrInProgress(status: ImportItemStatus): boolean {
  return status === 'PENDING' || status === 'CLAIMED';
}

/** Re-OCR is only allowed once the worker has finished or given up. */
export function canReOcr(status: ImportItemStatus): boolean {
  return !isOcrInProgress(status) && status !== 'DISCARDED';
}

export interface OcrQueueInfo {
  status: 'PENDING' | 'CLAIMED';
  /** 1-based position among pending items in this batch. */
  queuePosition: number | null;
  /** Claimed items plus pending items ahead of this one in the batch. */
  pendingAhead: number;
  pendingTotal: number;
  processingTotal: number;
  queuedSinceMs: number;
  processingForMs: number | null;
  attemptNo: number;
  isRetry: boolean;
}

type QueueItem = Pick<
  ImportItem,
  'id' | 'status' | 'pageIndex' | 'updatedAt' | 'attempts' | 'claimExpiresAt'
>;

export function computeBatchQueueInfo(
  item: QueueItem,
  batchItems: Array<Pick<ImportItem, 'id' | 'status' | 'pageIndex'>>,
  now = Date.now(),
): OcrQueueInfo | null {
  if (item.status !== 'PENDING' && item.status !== 'CLAIMED') return null;

  const pending = batchItems
    .filter((i) => i.status === 'PENDING')
    .sort((a, b) => a.pageIndex - b.pageIndex);
  const processing = batchItems.filter((i) => i.status === 'CLAIMED');

  const queueIndex = pending.findIndex((i) => i.id === item.id);
  const queuePosition = queueIndex >= 0 ? queueIndex + 1 : null;
  const pendingAhead = processing.length + Math.max(0, queueIndex);
  const attemptNo = item.attempts + 1;
  const isRetry = item.attempts > 0;

  if (item.status === 'CLAIMED') {
    const startedAt =
      item.claimExpiresAt > OCR_LEASE_MS
        ? item.claimExpiresAt - OCR_LEASE_MS
        : item.updatedAt;
    return {
      status: 'CLAIMED',
      queuePosition: null,
      pendingAhead: 0,
      pendingTotal: pending.length,
      processingTotal: processing.length,
      queuedSinceMs: 0,
      processingForMs: Math.max(0, now - startedAt),
      attemptNo,
      isRetry,
    };
  }

  return {
    status: 'PENDING',
    queuePosition,
    pendingAhead,
    pendingTotal: pending.length,
    processingTotal: processing.length,
    queuedSinceMs: Math.max(0, now - item.updatedAt),
    processingForMs: null,
    attemptNo,
    isRetry,
  };
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

export function describeOcrQueueInfo(info: OcrQueueInfo): { title: string; detail: string } {
  if (info.status === 'CLAIMED') {
    const elapsed = info.processingForMs ?? 0;
    const attempt = info.isRetry ? `retry ${info.attemptNo}` : `attempt ${info.attemptNo}`;
    const tail =
      info.pendingTotal > 0
        ? ` · ${info.pendingTotal} more queued in this batch`
        : '';
    return {
      title: 'OCR in progress',
      detail: `${attempt} · running ${formatDuration(elapsed)}${tail}`,
    };
  }

  const parts: string[] = [];
  if (info.queuePosition != null && info.pendingTotal > 0) {
    parts.push(`#${info.queuePosition} of ${info.pendingTotal} in queue`);
  } else {
    parts.push('Queued for OCR');
  }
  if (info.pendingAhead > 0) {
    parts.push(`${info.pendingAhead} ahead in this batch`);
  }
  if (info.processingTotal > 0) {
    parts.push(
      `${info.processingTotal} processing now`,
    );
  }
  parts.push(`waiting ${formatDuration(info.queuedSinceMs)}`);
  if (info.isRetry) {
    parts.push(`retry ${info.attemptNo}`);
  }

  return {
    title: info.isRetry ? 'Waiting to retry OCR' : 'Waiting for OCR',
    detail: parts.join(' · '),
  };
}

/** Compact label for batch grid tiles. */
export function compactOcrQueueLabel(info: OcrQueueInfo): string {
  if (info.status === 'CLAIMED') {
    return `Processing · ${formatDuration(info.processingForMs ?? 0)}`;
  }
  if (info.queuePosition != null && info.pendingTotal > 0) {
    return `#${info.queuePosition} in queue · ${formatDuration(info.queuedSinceMs)}`;
  }
  return `Queued · ${formatDuration(info.queuedSinceMs)}`;
}
