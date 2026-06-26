import { describe, expect, it } from 'vitest';

import { splitListItems } from '../LegalPage.js';

// Regression tests for the multi-line-bullet rendering bug.
// Every list item in the legal docs wraps with a 2-space-indented
// continuation line. Before the fix, `renderBlock` split on every `\n`,
// turning each continuation into a spurious extra <li>.

describe('splitListItems', () => {
  it('keeps a wrapped bullet item as a single entry', () => {
    const block = ['- First item that wraps onto', '  a second line.', '- Second item.'].join('\n');
    const items = splitListItems(block);
    expect(items).toHaveLength(2);
    expect(items[0]).toBe('First item that wraps onto a second line.');
    expect(items[1]).toBe('Second item.');
  });

  it('keeps a wrapped ordered item as a single entry', () => {
    const block = [
      '1. Step one which is long enough',
      '   to wrap to the next line.',
      '2. Step two.',
      '3. Step three.',
    ].join('\n');
    const items = splitListItems(block);
    expect(items).toHaveLength(3);
    expect(items[0]).toBe('Step one which is long enough to wrap to the next line.');
    expect(items[1]).toBe('Step two.');
    expect(items[2]).toBe('Step three.');
  });

  it('handles single-line bullets without regression', () => {
    const block = '- Alpha\n- Beta\n- Gamma';
    const items = splitListItems(block);
    expect(items).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('strips inline bold markers from multi-line items', () => {
    // The stripping here is of the list prefix only; inline() handles **bold**.
    const block = [
      '- **Personal use** (only you): broadly permissible. The',
      '  Service treats your private library the same way a notes app treats',
      '  your personal notes.',
    ].join('\n');
    const items = splitListItems(block);
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('**Personal use**');
    expect(items[0]).toContain('your personal notes.');
  });
});
