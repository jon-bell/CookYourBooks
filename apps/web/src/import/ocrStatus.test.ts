import { describe, expect, it } from 'vitest';
import {
  canReOcr,
  computeBatchQueueInfo,
  describeOcrQueueInfo,
  isOcrInProgress,
} from './ocrStatus.js';

const baseItem = {
  id: 'b',
  status: 'PENDING' as const,
  pageIndex: 1,
  updatedAt: Date.now() - 45_000,
  attempts: 0,
  claimExpiresAt: 0,
};

const batchItems = [
  { id: 'a', status: 'PENDING' as const, pageIndex: 0 },
  { id: 'b', status: 'PENDING' as const, pageIndex: 1 },
  { id: 'c', status: 'CLAIMED' as const, pageIndex: 2 },
];

describe('ocrStatus', () => {
  it('allows Re-OCR from any status except DISCARDED', () => {
    // isOcrInProgress remains a useful predicate elsewhere (queue
    // display, status pills). canReOcr used to gate it out, but a
    // stuck PENDING / CLAIMED item is exactly when the user needs
    // to force-reset via the server-side import_reset_item RPC.
    expect(isOcrInProgress('PENDING')).toBe(true);
    expect(isOcrInProgress('CLAIMED')).toBe(true);
    expect(canReOcr('PENDING')).toBe(true);
    expect(canReOcr('CLAIMED')).toBe(true);
    expect(canReOcr('OCR_DONE')).toBe(true);
    expect(canReOcr('OCR_FAILED')).toBe(true);
    expect(canReOcr('NEEDS_FALLBACK')).toBe(true);
    expect(canReOcr('REVIEWED')).toBe(true);
    expect(canReOcr('DISCARDED')).toBe(false);
  });

  it('computes queue position within a batch', () => {
    const info = computeBatchQueueInfo(baseItem, batchItems, Date.now());
    expect(info).toMatchObject({
      status: 'PENDING',
      queuePosition: 2,
      pendingTotal: 2,
      processingTotal: 1,
      pendingAhead: 2,
    });
    const { title, detail } = describeOcrQueueInfo(info!);
    expect(title).toBe('Waiting for OCR');
    expect(detail).toContain('#2 of 2 in queue');
    expect(detail).toContain('2 ahead in this batch');
  });

  it('reports processing elapsed time for claimed items', () => {
    const now = Date.now();
    const info = computeBatchQueueInfo(
      {
        id: 'c',
        status: 'CLAIMED',
        pageIndex: 2,
        updatedAt: now - 120_000,
        attempts: 1,
        claimExpiresAt: now - 120_000 + 300_000,
      },
      batchItems,
      now,
    );
    expect(info?.status).toBe('CLAIMED');
    expect(info?.processingForMs).toBe(120_000);
    expect(describeOcrQueueInfo(info!).detail).toContain('retry 2');
  });
});
