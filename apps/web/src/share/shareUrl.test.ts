import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { absoluteUrl, bareRecipeShareUrl, collectionShareUrl, recipeShareUrl } from './shareUrl.js';

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

  it('builds bare-uuid share links under /r/', () => {
    expect(bareRecipeShareUrl('11111111-2222-3333-4444-555555555555')).toBe(
      'https://cookyourbooks.app/r/11111111-2222-3333-4444-555555555555',
    );
  });

  it('keeps http(s) browser origins as-is (dev + preview deploys)', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    expect(absoluteUrl('/r/abc')).toBe('http://localhost:5173/r/abc');
    vi.stubGlobal('window', { location: { origin: 'https://preview-42.vercel.app' } });
    expect(absoluteUrl('/r/abc')).toBe('https://preview-42.vercel.app/r/abc');
  });

  it('mints canonical links from a non-http origin (Capacitor webview)', () => {
    vi.stubGlobal('window', { location: { origin: 'capacitor://localhost' } });
    expect(absoluteUrl('/r/abc')).toBe('https://cookyourbooks.app/r/abc');
  });

  it('mints canonical links on a native platform even when the origin looks https', () => {
    // Android Capacitor serves https://localhost — an https origin nobody
    // else can open. Native platform detection must win over the scheme.
    vi.stubGlobal('window', { location: { origin: 'https://localhost' } });
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    expect(absoluteUrl('/r/abc')).toBe('https://cookyourbooks.app/r/abc');
  });
});
