import { describe, expect, it } from 'vitest';

import {
  buildFinalizePayload,
  deriveGroups,
  mergeAllSplits,
  toggleInSet,
} from './groupingModel.js';
import type { ImportItem } from './model.js';

/** Minimal ImportItem stand-in — the model only reads `id` and `pageIndex`. */
function item(id: string, pageIndex: number): ImportItem {
  return { id, pageIndex } as unknown as ImportItem;
}

const pages = (n: number) => Array.from({ length: n }, (_, i) => item(`p${i}`, i));

describe('deriveGroups', () => {
  it('one recipe per page when no splits are removed', () => {
    const groups = deriveGroups(pages(4), new Set());
    expect(groups.map((g) => g.map((it) => it.id))).toEqual([['p0'], ['p1'], ['p2'], ['p3']]);
  });

  it('"2 sets of 2 pages" → two 2-page recipes (remove splits 0 and 2)', () => {
    const groups = deriveGroups(pages(4), new Set([0, 2]));
    expect(groups.map((g) => g.map((it) => it.id))).toEqual([
      ['p0', 'p1'],
      ['p2', 'p3'],
    ]);
  });

  it('all splits removed → one multi-page recipe', () => {
    const groups = deriveGroups(pages(4), mergeAllSplits(4));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((it) => it.id)).toEqual(['p0', 'p1', 'p2', 'p3']);
  });

  it('returns [] for no pages', () => {
    expect(deriveGroups([], new Set())).toEqual([]);
  });
});

describe('buildFinalizePayload', () => {
  it('emits [[primary, ...absorbed], …] preserving page order', () => {
    const groups = deriveGroups(pages(4), new Set([0, 2]));
    expect(buildFinalizePayload(groups)).toEqual([
      ['p0', 'p1'],
      ['p2', 'p3'],
    ]);
  });
});

describe('mergeAllSplits', () => {
  it('produces every internal split index', () => {
    expect([...mergeAllSplits(4)].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect([...mergeAllSplits(1)]).toEqual([]);
    expect([...mergeAllSplits(0)]).toEqual([]);
  });
});

describe('toggleInSet', () => {
  it('adds then removes an index without mutating the input', () => {
    const a = new Set<number>([1]);
    const b = toggleInSet(a, 2);
    expect([...b].sort((x, y) => x - y)).toEqual([1, 2]);
    expect([...a]).toEqual([1]); // original untouched
    const c = toggleInSet(b, 1);
    expect([...c]).toEqual([2]);
  });
});
