import { describe, expect, it } from 'vitest';
import { instruction, measured } from '@cookyourbooks/domain';
import {
  computeDraftDiff,
  diffListHighlights,
  formatBakeoffStatus,
} from './bakeoff.js';
import type { ParsedRecipeDraft } from '@cookyourbooks/domain';

describe('formatBakeoffStatus', () => {
  it('maps internal statuses to import-style labels', () => {
    expect(formatBakeoffStatus('PENDING', true)).toBe('Queued…');
    expect(formatBakeoffStatus('CLAIMED', true)).toBe('Processing…');
    expect(formatBakeoffStatus('PENDING', false)).toBe('Queued');
  });
});

describe('computeDraftDiff', () => {
  it('highlights changed ingredients on each side', () => {
    const left: ParsedRecipeDraft = {
      title: 'Cookies',
      ingredients: [measured({ name: 'flour', quantity: { type: 'EXACT', amount: 2, unit: 'cup' } })],
      instructions: [instruction({ stepNumber: 1, text: 'Mix.' })],
      leftover: [],
    };
    const right: ParsedRecipeDraft = {
      title: 'Cookies (revised)',
      ingredients: [
        measured({ name: 'all-purpose flour', quantity: { type: 'EXACT', amount: 2, unit: 'cup' } }),
      ],
      instructions: [instruction({ stepNumber: 1, text: 'Cream butter and sugar.' })],
      leftover: [],
    };
    const { left: lh, right: rh } = computeDraftDiff(left, right);
    expect(lh.title).toBe('change');
    expect(rh.title).toBe('change');
    expect(lh.ingredients[0]).toBe('del');
    expect(rh.ingredients[0]).toBe('add');
  });
});

describe('diffListHighlights', () => {
  it('maps unified diff back to per-side arrays', () => {
    const { left, right } = diffListHighlights(['a', 'b'], ['a', 'c']);
    expect(left).toEqual(['same', 'del']);
    expect(right).toEqual(['same', 'add']);
  });
});
