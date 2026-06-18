import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Supabase client so the URL builders can be exercised without env /
// network. `getPublicUrl` echoes the requested width into the URL so we can
// assert the `srcSet` descriptor wiring is correct.
const getPublicUrl = vi.fn((path: string, opts?: { transform?: { width?: number } }) => ({
  data: { publicUrl: `https://cdn.test/${path}?w=${opts?.transform?.width ?? 0}` },
}));
const from = vi.fn(() => ({ getPublicUrl }));

vi.mock('../supabase.js', () => ({ supabase: { storage: { from } } }));

const { COVER_WIDTHS, COVER_TRANSFORM_QUALITY, coverSrcSet, transformedCoverUrl } =
  await import('./coverUrl.js');

beforeEach(() => {
  getPublicUrl.mockClear();
  from.mockClear();
});

describe('transformedCoverUrl', () => {
  it('requests a width-resized public URL from the covers bucket with cover defaults', () => {
    const url = transformedCoverUrl('u1/r1-abcd1234.webp', 480);
    expect(from).toHaveBeenCalledWith('covers');
    expect(getPublicUrl).toHaveBeenCalledWith('u1/r1-abcd1234.webp', {
      transform: { width: 480, quality: COVER_TRANSFORM_QUALITY, resize: 'cover' },
    });
    expect(url).toBe('https://cdn.test/u1/r1-abcd1234.webp?w=480');
  });

  it('honors an explicit quality override', () => {
    transformedCoverUrl('p', 320, 50);
    expect(getPublicUrl).toHaveBeenCalledWith('p', {
      transform: { width: 320, quality: 50, resize: 'cover' },
    });
  });
});

describe('coverSrcSet', () => {
  it('emits one "<url> <w>w" descriptor per responsive width, in order', () => {
    const srcSet = coverSrcSet('cover.webp');
    const entries = srcSet.split(', ');
    expect(entries).toHaveLength(COVER_WIDTHS.length);
    entries.forEach((entry, i) => {
      const w = COVER_WIDTHS[i];
      expect(entry).toBe(`https://cdn.test/cover.webp?w=${w} ${w}w`);
    });
  });
});
