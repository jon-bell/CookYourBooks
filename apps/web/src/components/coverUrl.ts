// On-the-fly cover image URLs via Supabase Storage image transformations.
//
// Supabase Pro serves CDN-cached, on-the-fly resizes through the
// `render/image` endpoint — `getPublicUrl(path, { transform: { ... } })`.
// Rather than serve a fixed pre-resized file into every size of slot, we
// request a right-sized variant and let the CDN cache each (path, width)
// combo. A `srcSet` lets the browser pick the best width for its DPR + the
// `sizes` hint the rendering component supplies.

import { supabase } from '../supabase.js';

const BUCKET = 'covers';

/** Default transform quality (1-100) — a good size/quality tradeoff for covers. */
export const COVER_TRANSFORM_QUALITY = 70;

/**
 * Responsive widths offered in the `srcSet`, in CSS pixels. Covers render at
 * most ~400px CSS; the larger entries cover 2-3x retina and the recipe-page
 * hero. Keep ascending so `coverSrcSet` emits a well-ordered descriptor list.
 */
export const COVER_WIDTHS = [320, 480, 640, 960, 1280] as const;

/**
 * A CDN-cached, on-the-fly-resized public URL for a cover object. `resize:
 * 'cover'` matches the `object-cover` CSS the slots use (fill + crop, no
 * letterboxing).
 */
export function transformedCoverUrl(path: string, width: number, quality?: number): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path, {
    transform: { width, quality: quality ?? COVER_TRANSFORM_QUALITY, resize: 'cover' },
  }).data.publicUrl;
}

/**
 * Build a `srcSet` string offering each responsive width:
 * `"<url> 320w, <url> 480w, ..."`. Pair with a `sizes` hint so the browser
 * downloads only the width it needs.
 */
export function coverSrcSet(path: string, quality?: number): string {
  return COVER_WIDTHS.map((w) => `${transformedCoverUrl(path, w, quality)} ${w}w`).join(', ');
}
