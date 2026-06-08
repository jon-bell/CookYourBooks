// YouTube URL canonicalization for the Gemini fileData fileUri.
//
// Kept in its own module (not index.ts) so it's unit-testable without
// importing index.ts, whose top-level `Deno.serve` would boot a server.

/**
 * Reduce any YouTube URL to the canonical watch form Gemini's video
 * understanding accepts as a `fileData.fileUri`:
 * `https://www.youtube.com/watch?v=<id>`.
 *
 * Share sheets hand us tracking-laden links like
 * `https://youtube.com/watch?v=Oxeyj8gWxmE&si=HMDcW4Am716Pn-QB` (and bare
 * `youtu.be/<id>` shorteners). Gemini mishandles the extra query params, so
 * we strip everything but the 11-char video id and rebuild a clean watch URL.
 * Handles watch, youtu.be short links, and /shorts//live//embed//v/ paths.
 * Returns the input unchanged if no valid video id can be recovered (let the
 * downstream call fail loudly rather than silently rewriting to garbage).
 */
export function canonicalYouTubeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (u.pathname === '/watch') {
      id = u.searchParams.get('v');
    } else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/]+)/);
      if (m) id = m[1] ?? null;
    }
  }
  // YouTube video ids are exactly 11 url-safe-base64 chars.
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return raw;
}
