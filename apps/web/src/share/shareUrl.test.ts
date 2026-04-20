import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { absoluteUrl, recipeShareUrl, collectionShareUrl } from './shareUrl.js';

describe('shareUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { origin: 'https://cookyourbooks.app' },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps absolute URLs untouched', () => {
    expect(absoluteUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(absoluteUrl('http://example.com/x')).toBe('http://example.com/x');
  });

  it('prefixes path-only inputs with the current origin', () => {
    expect(absoluteUrl('/discover')).toBe('https://cookyourbooks.app/discover');
    expect(absoluteUrl('discover')).toBe('https://cookyourbooks.app/discover');
  });

  it('builds canonical recipe + collection share URLs', () => {
    expect(recipeShareUrl('col-1', 'rec-2')).toBe(
      'https://cookyourbooks.app/collections/col-1/recipes/rec-2',
    );
    expect(collectionShareUrl('col-1')).toBe('https://cookyourbooks.app/collections/col-1');
  });
});
