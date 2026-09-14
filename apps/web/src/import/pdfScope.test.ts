import { describe, expect, it } from 'vitest';

import { defaultScopeForPageCount, SINGLE_RECIPE_MAX_PAGES } from './PdfScopeStep.js';

describe('defaultScopeForPageCount', () => {
  it('treats a short PDF as one printed recipe', () => {
    // A recipe printed or saved from a website is one recipe over a few pages.
    expect(defaultScopeForPageCount(1)).toBe('one');
    expect(defaultScopeForPageCount(SINGLE_RECIPE_MAX_PAGES)).toBe('one');
  });

  it('treats a long PDF as a cookbook to split', () => {
    expect(defaultScopeForPageCount(SINGLE_RECIPE_MAX_PAGES + 1)).toBe('split');
    expect(defaultScopeForPageCount(120)).toBe('split');
  });

  it('never leaves the choice undefined for a degenerate count', () => {
    // 0 pages is rejected upstream, but the default must still be a valid scope
    // rather than undefined, so the step can always render a selection.
    expect(['one', 'split']).toContain(defaultScopeForPageCount(0));
  });
});
