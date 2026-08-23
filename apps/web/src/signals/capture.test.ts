import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchEventPayload, SuggestionEventPayload } from './api.js';
import {
  flushSignals,
  recordOnce,
  recordSearchEvent,
  recordSuggestionEvent,
  resetSignalsForTest,
  setSignalTransport,
} from './capture.js';
import { primeSignalsPref, signalsEnabled } from './prefs.js';

interface Captured {
  search: SearchEventPayload[][];
  suggestion: SuggestionEventPayload[][];
}

function fakeTransport(captured: Captured, fail = false) {
  return {
    search: (events: readonly SearchEventPayload[]) => {
      captured.search.push([...events]);
      return fail ? Promise.reject(new Error('nope')) : Promise.resolve();
    },
    suggestion: (events: readonly SuggestionEventPayload[]) => {
      captured.suggestion.push([...events]);
      return fail ? Promise.reject(new Error('nope')) : Promise.resolve();
    },
  };
}

let captured: Captured;

beforeEach(() => {
  // The account setting is fetched asynchronously in the app; here we set the
  // synchronous cache the enqueue gate actually reads.
  primeSignalsPref(true);
  resetSignalsForTest();
  captured = { search: [], suggestion: [] };
  setSignalTransport(fakeTransport(captured));
});

afterEach(() => {
  setSignalTransport();
  resetSignalsForTest();
  vi.useRealTimers();
});

const aQuery: SearchEventPayload = { query_id: 'q1', kind: 'query', query: 'salad' };

describe('recordSearchEvent', () => {
  it('batches everything buffered into one post', async () => {
    recordSearchEvent(aQuery);
    recordSearchEvent({ query_id: 'q1', kind: 'open', opened_recipe_id: 'r1', opened_rank: 2 });
    expect(captured.search).toHaveLength(0); // nothing sent before the flush

    await flushSignals();

    expect(captured.search).toHaveLength(1);
    expect(captured.search[0]).toHaveLength(2);
    expect(captured.search[0]![1]!.opened_rank).toBe(2);
  });

  it('sends nothing at all when there is nothing buffered', async () => {
    await flushSignals();
    expect(captured.search).toHaveLength(0);
    expect(captured.suggestion).toHaveLength(0);
  });

  it('flushes on the coalescing timer without an explicit call', async () => {
    vi.useFakeTimers();
    recordSearchEvent(aQuery);
    await vi.runAllTimersAsync();
    expect(captured.search).toHaveLength(1);
  });

  it('drops the oldest events past the buffer cap rather than growing', async () => {
    for (let i = 0; i < 60; i += 1) {
      recordSearchEvent({ query_id: `q${i}`, kind: 'query', query: String(i) });
    }
    await flushSignals();
    const sent = captured.search[0]!;
    expect(sent).toHaveLength(40);
    // Newest kept, oldest dropped.
    expect(sent[0]!.query).toBe('20');
    expect(sent[39]!.query).toBe('59');
  });
});

describe('opt-out', () => {
  it('drops events enqueued while opted out', async () => {
    primeSignalsPref(false);
    expect(signalsEnabled()).toBe(false);

    recordSearchEvent(aQuery);
    recordSuggestionEvent({ surface: 'tag', action: 'accepted' });
    await flushSignals();

    expect(captured.search).toHaveLength(0);
    expect(captured.suggestion).toHaveLength(0);
  });

  it('resumes when switched back on', async () => {
    primeSignalsPref(false);
    recordSearchEvent(aQuery);
    primeSignalsPref(true);
    recordSearchEvent({ query_id: 'q2', kind: 'query', query: 'soup' });
    await flushSignals();

    expect(captured.search[0]).toHaveLength(1);
    expect(captured.search[0]![0]!.query).toBe('soup');
  });
});

describe('flushSignals', () => {
  it('never rejects when the transport fails, and does not re-send', async () => {
    setSignalTransport(fakeTransport(captured, true));
    recordSearchEvent(aQuery);

    await expect(flushSignals()).resolves.toBeUndefined();
    // A failed flush is dropped, not re-buffered: retrying would
    // over-represent users on flaky connections in whatever we train.
    await flushSignals();
    expect(captured.search).toHaveLength(1);
  });

  it('drains the buffer before awaiting, so a racing enqueue is not sent twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setSignalTransport({
      search: (events) => {
        captured.search.push([...events]);
        return gate;
      },
      suggestion: () => Promise.resolve(),
    });

    recordSearchEvent(aQuery);
    const inFlight = flushSignals();
    recordSearchEvent({ query_id: 'q2', kind: 'query', query: 'soup' });
    release();
    await inFlight;

    setSignalTransport(fakeTransport(captured));
    await flushSignals();

    expect(captured.search.map((batch) => batch.map((e) => e.query))).toEqual([
      ['salad'],
      ['soup'],
    ]);
  });
});

describe('recordOnce', () => {
  it('is true the first time a key is seen and false after', () => {
    expect(recordOnce('nutrition:butter')).toBe(true);
    expect(recordOnce('nutrition:butter')).toBe(false);
    expect(recordOnce('nutrition:flour')).toBe(true);
  });

  it('stops admitting new keys at the cap instead of evicting', () => {
    for (let i = 0; i < 2_000; i += 1) recordOnce(`k${i}`);
    // A false "new" would let a hot key re-fire forever, so the cap fails
    // closed: past it, nothing is admitted.
    expect(recordOnce('k-past-the-cap')).toBe(false);
    expect(recordOnce('k0')).toBe(false);
  });
});
