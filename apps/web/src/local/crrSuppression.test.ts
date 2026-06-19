import { describe, expect, it } from 'vitest';
import {
  CRR_SUPPRESS_MIN_ROWS,
  shouldSuppressCrrTriggers,
} from './crrSuppression.js';

describe('shouldSuppressCrrTriggers', () => {
  it('never suppresses below the row floor, regardless of table size', () => {
    // The original pathology: a 1-row echo pull paying a full table-sized
    // commit_alter. Small batches stay tracked even into an empty table.
    expect(shouldSuppressCrrTriggers(0, 0)).toBe(false);
    expect(shouldSuppressCrrTriggers(1, 0)).toBe(false);
    expect(shouldSuppressCrrTriggers(CRR_SUPPRESS_MIN_ROWS - 1, 0)).toBe(false);
    expect(shouldSuppressCrrTriggers(CRR_SUPPRESS_MIN_ROWS - 1, 100_000)).toBe(false);
  });

  it('suppresses a cold hydrate (large batch into an empty table)', () => {
    expect(shouldSuppressCrrTriggers(CRR_SUPPRESS_MIN_ROWS, 0)).toBe(true);
    expect(shouldSuppressCrrTriggers(10_000, 0)).toBe(true);
  });

  it('suppresses a whole-library re-pull (batch ≈ table)', () => {
    expect(shouldSuppressCrrTriggers(16_000, 16_000)).toBe(true);
    expect(shouldSuppressCrrTriggers(16_000, 30_000)).toBe(true); // ≥ 50%
  });

  it('does NOT suppress an incremental pull into a large table', () => {
    // The regression that wedged the pull: ~500 changed rows into a 160k-row
    // ingredients table used to clear the absolute-200 threshold and pay a
    // ~50s commit_alter. Now it stays tracked (per-row triggers).
    expect(shouldSuppressCrrTriggers(500, 160_000)).toBe(false);
    expect(shouldSuppressCrrTriggers(2_000, 160_000)).toBe(false);
    // Right at the half-of-table boundary it flips on.
    expect(shouldSuppressCrrTriggers(80_000, 160_000)).toBe(true);
  });
});
