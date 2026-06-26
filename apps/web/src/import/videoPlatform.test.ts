import { describe, expect, it } from 'vitest';

import { detectVideoPlatform, firstVideoUrl } from './videoPlatform.js';

describe('detectVideoPlatform', () => {
  it('recognises YouTube variants', () => {
    expect(detectVideoPlatform('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectVideoPlatform('https://youtube.com/shorts/xyz')).toBe('youtube');
    expect(detectVideoPlatform('https://m.youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectVideoPlatform('https://youtu.be/abc')).toBe('youtube');
  });

  it('recognises TikTok variants', () => {
    expect(detectVideoPlatform('https://www.tiktok.com/@chef/video/123')).toBe('tiktok');
    expect(detectVideoPlatform('https://vm.tiktok.com/ZMabc/')).toBe('tiktok');
  });

  it('recognises Instagram variants', () => {
    expect(detectVideoPlatform('https://www.instagram.com/reel/abc/')).toBe('instagram');
    expect(detectVideoPlatform('https://instagram.com/p/abc/')).toBe('instagram');
  });

  it('rejects unsupported / malformed URLs', () => {
    expect(detectVideoPlatform('https://example.com/recipe')).toBeNull();
    expect(detectVideoPlatform('not a url')).toBeNull();
    expect(detectVideoPlatform('https://notyoutube.com.evil.com/')).toBeNull();
  });
});

describe('firstVideoUrl', () => {
  it('extracts a supported URL embedded in shared text', () => {
    expect(firstVideoUrl('Check this out https://youtu.be/abc #yum')).toBe('https://youtu.be/abc');
  });

  it('returns a bare supported URL unchanged', () => {
    expect(firstVideoUrl('https://www.tiktok.com/@a/video/1')).toBe(
      'https://www.tiktok.com/@a/video/1',
    );
  });

  it('returns null when no supported URL is present', () => {
    expect(firstVideoUrl('just some text')).toBeNull();
    expect(firstVideoUrl('https://example.com/x')).toBeNull();
    expect(firstVideoUrl(null)).toBeNull();
    expect(firstVideoUrl(undefined)).toBeNull();
  });
});
