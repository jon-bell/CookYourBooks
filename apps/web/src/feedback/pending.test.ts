import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubmitFeedbackInput } from './api.js';
import type { FeedbackPayload } from './payload.js';
import {
  clearPending,
  flushPending,
  type PendingReport,
  queuePending,
  readPending,
} from './pending.js';

// These tests run in the node environment (this package has no jsdom), so stand
// up the minimum localStorage the module needs.
function installStorage(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

const payload = { device: { release: 'r1' } } as unknown as FeedbackPayload;
const input = (body: string): SubmitFeedbackInput => ({ kind: 'bug', body, route: '/search' });

describe('pending feedback queue', () => {
  beforeEach(() => {
    installStorage();
    clearPending();
  });

  it('round-trips a queued report', () => {
    queuePending(input('offline report'), payload);
    const list = readPending();
    expect(list).toHaveLength(1);
    expect(list[0]?.input.body).toBe('offline report');
    // The payload captured at bug time is kept, not re-collected later.
    expect(list[0]?.payload.device.release).toBe('r1');
  });

  it('caps the backlog, keeping the newest', () => {
    for (let i = 0; i < 9; i += 1) queuePending(input(`report ${i}`), payload);
    const list = readPending();
    expect(list).toHaveLength(5);
    expect(list[0]?.input.body).toBe('report 4');
    expect(list[4]?.input.body).toBe('report 8');
  });

  it('clears the queue when everything sends', async () => {
    queuePending(input('a'), payload);
    queuePending(input('b'), payload);
    const send = vi.fn<(p: PendingReport) => Promise<void>>().mockResolvedValue();

    const result = await flushPending(send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 2, remaining: 0 });
    expect(readPending()).toHaveLength(0);
  });

  it('stops at the first failure and keeps the rest in order', async () => {
    queuePending(input('a'), payload);
    queuePending(input('b'), payload);
    queuePending(input('c'), payload);
    const send = vi
      .fn<(p: PendingReport) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('still offline'));

    const result = await flushPending(send);

    // Stops rather than burning the whole backlog against a dead network.
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 1, remaining: 2 });
    expect(readPending().map((p) => p.input.body)).toEqual(['b', 'c']);
  });

  it('is a no-op when nothing is queued', async () => {
    const send = vi.fn<(p: PendingReport) => Promise<void>>().mockResolvedValue();
    expect(await flushPending(send)).toEqual({ sent: 0, remaining: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('survives a corrupt stored value', () => {
    localStorage.setItem('cookyourbooks.feedback.pending.v1', '{not json');
    expect(readPending()).toEqual([]);
  });
});
