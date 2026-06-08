import { describe, expect, it } from 'vitest';
import { urlFromIntent } from './shareUrlParse.js';

// Build the cookyourbooks:// deep link the native share extension opens
// (params percent-encoded), mirroring ShareViewController.sendData().
function deepLink(parts: { url?: string; title?: string; description?: string }): string {
  const enc = (s: string) => encodeURIComponent(s);
  const q = [
    `title=${enc(parts.title ?? '')}`,
    `description=${enc(parts.description ?? '')}`,
    `type=${enc('text/plain')}`,
    `url=${enc(parts.url ?? '')}`,
  ].join('&');
  return `cookyourbooks://?${q}`;
}

describe('urlFromIntent', () => {
  it('reads the URL from the embedded url param (public.url share)', () => {
    const payload = { url: deepLink({ url: 'https://www.seriouseats.com/pancakes' }) };
    expect(urlFromIntent(payload)).toEqual({
      url: 'https://www.seriouseats.com/pancakes',
      platform: null,
    });
  });

  it('recovers a link from the embedded title when url is empty (text share)', () => {
    // Regression: plain-text shares land in `title` with `url` empty — the
    // appUrlOpen path used to report no_url (Sentry CYB-CAPACITOR-D).
    const payload = {
      url: deepLink({ title: 'Check out this recipe https://cooking.nytimes.com/x' }),
    };
    expect(urlFromIntent(payload)).toEqual({
      url: 'https://cooking.nytimes.com/x',
      platform: null,
    });
  });

  it('detects a social platform embedded in the title', () => {
    const payload = { url: deepLink({ title: 'yum https://www.youtube.com/watch?v=abc' }) };
    expect(urlFromIntent(payload)).toEqual({
      url: 'https://www.youtube.com/watch?v=abc',
      platform: 'youtube',
    });
  });

  it('handles the top-level SendIntent shape (title carries the link)', () => {
    const payload = { url: '', title: 'https://www.bbcgoodfood.com/recipes/x', type: 'text/plain' };
    expect(urlFromIntent(payload)).toEqual({
      url: 'https://www.bbcgoodfood.com/recipes/x',
      platform: null,
    });
  });

  it('recovers a double-encoded link from title (legacy build, CYB-CAPACITOR-D)', () => {
    // The exact malformed deep link from the Sentry report: a YouTube
    // link shared as text, double-encoded into `title` (url empty). Older
    // ShareViewController builds pre-encoded with .urlHostAllowed AND let
    // URLComponents re-encode, so `%3A` became `%253A`.
    const raw =
      'cookyourbooks://?title=https%253A%252F%252Fyoutube.com%252Fwatch%253Fv%3DOxeyj8gWxmE%26si%3DwPbodmA8G2eWkWtZ&description=&type=text%252Fplain&url=';
    expect(urlFromIntent({ url: raw })).toEqual({
      url: 'https://youtube.com/watch?v=Oxeyj8gWxmE&si=wPbodmA8G2eWkWtZ',
      platform: 'youtube',
    });
  });

  it('recovers a double-encoded link from the url param (public.url share)', () => {
    // NYT Cooking shares as public.url → both title and url were
    // double-encoded; the generic recipe site must still resolve.
    const raw =
      'cookyourbooks://?title=https%253A%252F%252Fcooking.nytimes.com%252Frecipes%252F1234&description=&type=text%252Fplain&url=https%253A%252F%252Fcooking.nytimes.com%252Frecipes%252F1234';
    expect(urlFromIntent({ url: raw })).toEqual({
      url: 'https://cooking.nytimes.com/recipes/1234',
      platform: null,
    });
  });

  it('returns no url when nothing parseable is present', () => {
    expect(urlFromIntent({ url: deepLink({ title: 'just some text, no link' }) })).toEqual({
      url: null,
      platform: null,
    });
    expect(urlFromIntent({})).toEqual({ url: null, platform: null });
  });
});
