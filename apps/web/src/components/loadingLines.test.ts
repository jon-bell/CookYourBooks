import { describe, expect, it } from 'vitest';
import { COOKING_FLAVOR_LINES, interleaveLines } from './loadingLines.js';

describe('interleaveLines', () => {
  it('alternates info and flavor 1:1 so every other line is informational', () => {
    const out = interleaveLines(['Fetching…'], ['Reticulating roux…', 'Proofing…']);
    expect(out).toEqual([
      'Fetching…',
      'Reticulating roux…',
      'Fetching…',
      'Proofing…',
    ]);
  });

  it('cycles multiple info lines through the rotation', () => {
    const out = interleaveLines(['a', 'b'], ['x', 'y', 'z']);
    expect(out).toEqual(['a', 'x', 'b', 'y', 'a', 'z']);
  });

  it('falls back to pure flavor with no info lines', () => {
    expect(interleaveLines([])).toEqual([...COOKING_FLAVOR_LINES]);
  });

  it('falls back to pure info with no flavor lines', () => {
    expect(interleaveLines(['only'], [])).toEqual(['only']);
  });
});
