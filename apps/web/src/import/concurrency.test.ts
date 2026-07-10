import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from './concurrency.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` calls at once', async () => {
    const gates = Array.from({ length: 6 }, deferred);
    let inFlight = 0;
    let peak = 0;
    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gates[i]!.promise;
      inFlight -= 1;
    });
    // Release one at a time so the pool has to backfill from the queue.
    for (const g of gates) {
      await Promise.resolve();
      g.resolve();
    }
    await run;
    expect(peak).toBe(2);
  });

  it('processes every item and resolves with no failures on success', async () => {
    const seen: number[] = [];
    const failures = await mapWithConcurrency([10, 20, 30], 8, async (item, index) => {
      await Promise.resolve();
      seen.push(item + index);
    });
    expect(failures).toEqual([]);
    expect(seen.sort((a, b) => a - b)).toEqual([10, 21, 32]);
  });

  it('collects a rejection without aborting the remaining items', async () => {
    const done: number[] = [];
    const failures = await mapWithConcurrency([0, 1, 2, 3], 2, async (i) => {
      await Promise.resolve();
      if (i === 1) throw new Error('boom');
      done.push(i);
    });
    expect(done.sort()).toEqual([0, 2, 3]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.item).toBe(1);
    expect(failures[0]!.index).toBe(1);
    expect(failures[0]!.error.message).toBe('boom');
  });

  it('fires onSettled exactly once per item, with the error on failures', async () => {
    const settled: Array<{ index: number; failed: boolean }> = [];
    await mapWithConcurrency(
      ['a', 'b', 'c'],
      1,
      async (item) => {
        await Promise.resolve();
        if (item === 'b') throw new Error('nope');
      },
      ({ index, error }) => settled.push({ index, failed: error !== undefined }),
    );
    expect(settled).toEqual([
      { index: 0, failed: false },
      { index: 1, failed: true },
      { index: 2, failed: false },
    ]);
  });

  it('wraps non-Error throws', async () => {
    const failures = await mapWithConcurrency([1], 4, () => Promise.reject('raw string'));
    expect(failures[0]!.error).toBeInstanceOf(Error);
    expect(failures[0]!.error.message).toBe('raw string');
  });

  it('handles an empty item list', async () => {
    expect(await mapWithConcurrency([], 4, () => Promise.resolve())).toEqual([]);
  });
});
