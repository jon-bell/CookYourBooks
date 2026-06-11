import { describe, expect, it } from 'vitest';

import { type PageKind, type PageMarker, planPageGroups } from './pageMarker.js';

const m = (kind: PageKind = 'RECIPE', joinsPrevious = false): PageMarker => ({
  kind,
  joinsPrevious,
});
const page = (id: string, marker: PageMarker) => ({ id, marker });

describe('planPageGroups', () => {
  it('makes each non-continuation page its own leader with contiguous page_index', () => {
    const groups = planPageGroups([page('a', m()), page('b', m()), page('c', m())]);
    expect(groups.map((g) => g.leaderId)).toEqual(['a', 'b', 'c']);
    expect(groups.map((g) => g.pageIndex)).toEqual([0, 1, 2]);
    expect(groups.every((g) => g.extraIds.length === 0)).toBe(true);
  });

  it('folds a joinsPrevious page into the previous leader and renumbers', () => {
    const groups = planPageGroups([
      page('a', m('RECIPE')),
      page('b', m('RECIPE', true)),
      page('c', m('RECIPE')),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.leaderId).toBe('a');
    expect(groups[0]!.extraIds).toEqual(['b']);
    expect(groups[0]!.pageIndex).toBe(0);
    expect(groups[1]!.leaderId).toBe('c');
    expect(groups[1]!.pageIndex).toBe(1);
  });

  it('chains multiple continuation pages into one leader', () => {
    const groups = planPageGroups([
      page('a', m()),
      page('b', m('RECIPE', true)),
      page('c', m('RECIPE', true)),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.extraIds).toEqual(['b', 'c']);
  });

  it('carries the leader kind (TOC / NOTES)', () => {
    const groups = planPageGroups([page('a', m('TOC')), page('b', m('NOTES'))]);
    expect(groups[0]!.kind).toBe('TOC');
    expect(groups[1]!.kind).toBe('NOTES');
  });

  it('treats a leading joinsPrevious page (no predecessor) as its own leader', () => {
    const groups = planPageGroups([page('a', m('RECIPE', true)), page('b', m())]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.leaderId).toBe('a');
    expect(groups[0]!.extraIds).toEqual([]);
  });

  it('folds a trailing continuation into the prior leader', () => {
    const groups = planPageGroups([page('a', m()), page('b', m('RECIPE', true))]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.extraIds).toEqual(['b']);
  });

  it('returns no groups for an empty input', () => {
    expect(planPageGroups([])).toEqual([]);
  });
});
