import { describe, expect, it } from 'vitest';

import type { FeedbackPayload } from './payload.js';
import { payloadSize, trimToLimit } from './payload.js';

function makePayload(over: Partial<FeedbackPayload> = {}): FeedbackPayload {
  return {
    breadcrumbs: [],
    syncLog: [],
    consoleTail: [],
    device: {
      release: 'abc1234',
      platform: 'web',
      environment: 'test',
      online: true,
      userAgent: 'test-agent',
      language: 'en',
      timeZone: 'UTC',
      viewport: { width: 1024, height: 768, dpr: 2 },
      localTime: '2026-08-23T00:00:00.000Z',
    },
    ...over,
  };
}

const syncEntry = (i: number) => ({
  id: i,
  at: 1_700_000_000_000 + i,
  level: 'info' as const,
  message: `pull recipes chunk ${i} ${'detail '.repeat(20)}`,
});

const crumb = (i: number) => ({
  id: i,
  at: 1_700_000_000_000 + i,
  kind: 'click' as const,
  label: `button ${i}`,
});

describe('feedback payload', () => {
  it('leaves a small payload untouched', () => {
    const p = makePayload({ syncLog: [syncEntry(1)], breadcrumbs: [crumb(1)] });
    expect(trimToLimit(p)).toBe(p);
  });

  it('drops the sync log first when over the limit', () => {
    const p = makePayload({
      syncLog: Array.from({ length: 150 }, (_, i) => syncEntry(i)),
      breadcrumbs: Array.from({ length: 100 }, (_, i) => crumb(i)),
    });
    // Calibrate the limit so the sync log alone is what puts it over: just
    // above what everything-except-the-sync-log costs.
    const withoutLog = payloadSize({ ...p, syncLog: [] });
    expect(payloadSize(p)).toBeGreaterThan(withoutLog);
    const trimmed = trimToLimit(p, withoutLog + 500);

    expect(payloadSize(trimmed)).toBeLessThanOrEqual(withoutLog + 500);
    expect(trimmed.syncLog.length).toBeLessThan(p.syncLog.length);
    // Breadcrumbs — the actually-useful trail — survive this stage.
    expect(trimmed.breadcrumbs).toHaveLength(100);
  });

  it('sheds breadcrumbs only as a last resort, keeping the newest', () => {
    const p = makePayload({
      syncLog: Array.from({ length: 150 }, (_, i) => syncEntry(i)),
      breadcrumbs: Array.from({ length: 100 }, (_, i) => crumb(i)),
    });
    const trimmed = trimToLimit(p, 1200);
    expect(trimmed.syncLog).toHaveLength(0);
    expect(trimmed.consoleTail).toHaveLength(0);
    expect(trimmed.breadcrumbs).toHaveLength(25);
    expect(trimmed.breadcrumbs[trimmed.breadcrumbs.length - 1]?.label).toBe('button 99');
  });

  it('always keeps the device context, which is the cheapest useful signal', () => {
    const p = makePayload({
      syncLog: Array.from({ length: 150 }, (_, i) => syncEntry(i)),
    });
    expect(trimToLimit(p, 200).device.release).toBe('abc1234');
  });
});
