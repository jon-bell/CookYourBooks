import { describe, expect, it } from 'vitest';

import { CRR_SUPPRESS_MIN_ROWS, shouldSuppressCrrTriggers } from './crrSuppression.js';

describe('shouldSuppressCrrTriggers', () => {
  it('does not suppress for the incremental steady state', () => {
    // The pathology we fixed: a 1-row echo pull paying a full
    // table-sized commit_alter. Small batches stay tracked.
    expect(shouldSuppressCrrTriggers(0)).toBe(false);
    expect(shouldSuppressCrrTriggers(1)).toBe(false);
    expect(shouldSuppressCrrTriggers(CRR_SUPPRESS_MIN_ROWS - 1)).toBe(false);
  });

  it('suppresses once a batch is large enough to amortise commit_alter', () => {
    expect(shouldSuppressCrrTriggers(CRR_SUPPRESS_MIN_ROWS)).toBe(true);
    expect(shouldSuppressCrrTriggers(CRR_SUPPRESS_MIN_ROWS + 1)).toBe(true);
    expect(shouldSuppressCrrTriggers(10_000)).toBe(true);
  });
});
