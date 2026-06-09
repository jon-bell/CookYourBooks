// Server-side cover re-encoding for the Gemini cover worker.
//
// Gemini returns the generated cover as a raw PNG (often 1-2 MB). Before we
// store it in the public `covers` bucket we downscale to a sane display size
// and re-encode as JPEG so it loads fast and caches well — the same goal as
// the browser's WebP path (apps/web/src/recipe/coverImage.ts), but here we use
// imagescript (pure TypeScript/WASM-free, so no edge cold-start hit). Decode
// only handles PNG/JPEG; on any failure we fall back to the original bytes so
// a generation is never lost to an encoding hiccup.
//
// Shared with scripts/optimize-covers.ts (the one-time backfill).

import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';

/** Longest-edge cap — matches the browser cover path. */
export const COVER_MAX_EDGE = 1280;
/** Longest-edge cap for gallery thumbnails — matches COVER_THUMB_MAX_EDGE in coverImage.ts. */
export const COVER_THUMB_MAX_EDGE = 640;
/** JPEG quality (imagescript: 1-100). */
export const COVER_QUALITY = 82;
/** Immutable 1-year cache. Safe because new writes are content-addressed. */
export const COVER_CACHE_CONTROL = '31536000, immutable';

export interface ReencodedCover {
  bytes: Uint8Array;
  ext: string;
  contentType: string;
}

/**
 * Downscale `bytes` to `COVER_MAX_EDGE` and re-encode as JPEG. Returns the
 * original bytes unchanged (with a derived ext/contentType) if decoding or
 * re-encoding fails, or if the input is already smaller than the result.
 */
export async function reencodeCover(bytes: Uint8Array, mime: string): Promise<ReencodedCover> {
  const passthrough: ReencodedCover = {
    bytes,
    ext: mime.includes('webp') ? 'webp' : mime.includes('png') ? 'png' : 'jpg',
    contentType: mime || 'image/jpeg',
  };
  try {
    const img = await Image.decode(bytes);
    const longest = Math.max(img.width, img.height);
    if (longest > COVER_MAX_EDGE) {
      const scale = COVER_MAX_EDGE / longest;
      img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
    }
    const out = await img.encodeJPEG(COVER_QUALITY);
    // Keep whichever is smaller — a tiny source PNG can beat a re-encode.
    if (out.length >= bytes.length) return passthrough;
    return { bytes: out, ext: 'jpg', contentType: 'image/jpeg' };
  } catch {
    return passthrough;
  }
}

/**
 * Derive the thumb storage path for a given full-size cover path.
 * Pure string append — mirrors thumbPathFor in coverImage.ts.
 */
export function thumbPathFor(path: string): string {
  return `${path}.thumb.jpg`;
}

/**
 * Downscale `bytes` to `COVER_THUMB_MAX_EDGE` and re-encode as JPEG for use
 * as a gallery thumbnail. Falls back to the full-size passthrough on any error.
 */
export async function reencodeThumb(bytes: Uint8Array, mime: string): Promise<ReencodedCover> {
  try {
    const img = await Image.decode(bytes);
    const longest = Math.max(img.width, img.height);
    if (longest > COVER_THUMB_MAX_EDGE) {
      const scale = COVER_THUMB_MAX_EDGE / longest;
      img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
    }
    const out = await img.encodeJPEG(COVER_QUALITY);
    return { bytes: out, ext: 'jpg', contentType: 'image/jpeg' };
  } catch {
    // Fall back to full bytes — thumb is best-effort.
    const passthrough: ReencodedCover = {
      bytes,
      ext: mime.includes('webp') ? 'webp' : mime.includes('png') ? 'png' : 'jpg',
      contentType: mime || 'image/jpeg',
    };
    return passthrough;
  }
}

/**
 * Content-addressed storage key: `${prefix}/${id}-${hash8}.${ext}`. Mirrors
 * the browser's coverObjectKey so a replaced cover lands on a fresh URL.
 */
export async function coverObjectKey(
  prefix: string,
  id: string,
  bytes: Uint8Array,
  ext: string,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}/${id}-${hex.slice(0, 8)}.${ext}`;
}
