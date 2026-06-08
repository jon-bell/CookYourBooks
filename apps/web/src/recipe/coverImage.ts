// Client-side cover-image preparation.
//
// Cover images (recipe + collection) used to be uploaded raw — a multi-MB
// phone photo went straight into the public `covers` bucket and was served
// full-res into every 8x8 thumbnail. This downscales + re-encodes to a small
// WebP (JPEG fallback for runtimes whose canvas can't encode WebP — older
// WKWebView) before upload, and content-addresses the storage key so a
// replaced cover lands on a fresh URL and the bytes can be cached forever.
//
// The OCR import flow has its own JPEG pipeline (import/imageProcessing.ts);
// covers want WebP and a single display size, so they live here.

/** Longest-edge cap. Covers render at most ~400px CSS; this covers 2-3x retina. */
export const COVER_MAX_EDGE = 1280;
/** WebP/JPEG quality (canvas encode, 0-1). */
export const COVER_QUALITY = 0.82;
/** Immutable 1-year cache. Safe because new writes are content-addressed. */
export const COVER_CACHE_CONTROL = '31536000, immutable';

export interface PreparedCover {
  blob: Blob;
  /** File extension matching the encoded bytes (`webp` or `jpg`). */
  ext: string;
  /** Content-Type to stamp on the storage object. */
  contentType: string;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function encode(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), type, quality),
  );
}

/**
 * Decode, downscale to `COVER_MAX_EDGE`, and re-encode `input` as a small
 * WebP — falling back to JPEG when the runtime's canvas can't produce WebP
 * (it silently yields PNG, which we detect via the result's MIME type).
 */
export async function prepareCoverImage(input: File | Blob): Promise<PreparedCover> {
  // `imageOrientation: 'from-image'` bakes EXIF rotation into the pixels —
  // canvas otherwise ignores it and a portrait phone photo lands sideways.
  const bitmap = await createImageBitmap(input, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, COVER_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('Could not acquire 2D canvas context');
    ctx.drawImage(bitmap, 0, 0, width, height);

    let blob = await encode(canvas, 'image/webp', COVER_QUALITY);
    if (blob.type !== 'image/webp') {
      blob = await encode(canvas, 'image/jpeg', COVER_QUALITY);
    }
    const contentType = blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const ext = contentType === 'image/webp' ? 'webp' : 'jpg';
    return { blob, ext, contentType };
  } finally {
    bitmap.close();
  }
}

/**
 * Content-addressed storage key: `${prefix}/${id}-${hash8}.${ext}`. The hash
 * of the encoded bytes changes whenever the cover changes, so the public URL
 * is naturally cache-busted and the object can carry an immutable 1-year TTL.
 */
export async function coverObjectKey(
  prefix: string,
  id: string,
  bytes: ArrayBuffer,
  ext: string,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}/${id}-${hex.slice(0, 8)}.${ext}`;
}
