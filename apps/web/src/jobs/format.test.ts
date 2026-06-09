import { describe, expect, it } from 'vitest';
import type { BatchJobRow } from './api.js';
import {
  isInFlight,
  jobKindLabel,
  sortJobsForFeed,
  statusLabel,
  statusPillClass,
} from './format.js';

describe('jobKindLabel', () => {
  it('maps known kinds and passes through unknowns', () => {
    expect(jobKindLabel('ocr')).toBe('OCR import');
    expect(jobKindLabel('remix')).toBe('Recipe Remix');
    expect(jobKindLabel('cover')).toBe('Cover image');
    expect(jobKindLabel('mystery')).toBe('mystery');
  });
});

describe('statusLabel', () => {
  it('maps each normalized status', () => {
    expect(statusLabel('pending')).toBe('Queued');
    expect(statusLabel('running')).toBe('Running');
    expect(statusLabel('done')).toBe('Done');
    expect(statusLabel('failed')).toBe('Failed');
    expect(statusLabel('weird')).toBe('weird');
  });
});

describe('statusPillClass', () => {
  it('colour-codes by outcome', () => {
    expect(statusPillClass('done')).toContain('emerald');
    expect(statusPillClass('failed')).toContain('red');
    expect(statusPillClass('running')).toContain('sky');
    expect(statusPillClass('pending')).toContain('amber');
    // Unknown falls back to the pending (amber) styling.
    expect(statusPillClass('???')).toContain('amber');
  });
});

describe('isInFlight', () => {
  it('is true only for pending/running', () => {
    expect(isInFlight('pending')).toBe(true);
    expect(isInFlight('running')).toBe(true);
    expect(isInFlight('done')).toBe(false);
    expect(isInFlight('failed')).toBe(false);
  });
});

describe('sortJobsForFeed', () => {
  const row = (id: string, status: string, updated_at: string): BatchJobRow =>
    ({
      kind: 'rewrite',
      id,
      owner_id: 'o',
      household_id: null,
      requested_by: 'o',
      status: status as BatchJobRow['status'],
      created_at: updated_at,
      updated_at,
      attempts: 0,
      last_error: null,
      target_kind: 'recipe',
      target_id: 'r',
      pending_count: null,
      done_count: null,
      failed_count: null,
    }) satisfies BatchJobRow;

  it('puts in-flight first, then newest-activity-first within each group', () => {
    const rows = [
      row('done-old', 'done', '2026-06-01T00:00:00Z'),
      row('done-new', 'done', '2026-06-08T00:00:00Z'),
      row('run-old', 'running', '2026-06-02T00:00:00Z'),
      row('pend-new', 'pending', '2026-06-09T00:00:00Z'),
    ];
    expect(sortJobsForFeed(rows).map((r) => r.id)).toEqual([
      'pend-new', // in-flight, newest
      'run-old', // in-flight, older
      'done-new', // terminal, newest
      'done-old', // terminal, oldest
    ]);
  });

  it('does not mutate the input array', () => {
    const rows = [row('a', 'done', '2026-06-01T00:00:00Z'), row('b', 'pending', '2026-06-02T00:00:00Z')];
    const before = rows.map((r) => r.id);
    sortJobsForFeed(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});
