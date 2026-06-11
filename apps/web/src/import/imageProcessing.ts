// Client-side image preparation helpers for the bulk import flow.
//
// `renderPdfToJpegs` lazy-loads pdfjs-dist so the main bundle isn't
// dragged down for users who never upload a PDF. The worker is wired
// through Vite's `?worker&url` import so it resolves under both dev and
// production builds.

const PAGE_WIDTH = 1500;
const THUMB_WIDTH = 256;
const JPEG_QUALITY = 0.85;

export interface PreparedPage {
  /** Full-size JPEG for the OCR worker. */
  fullJpeg: Blob;
  /** Thumbnail JPEG for the batch grid. */
  thumbJpeg: Blob;
  /** Pixel dimensions of the full-size JPEG. */
  width: number;
  height: number;
  /** Original PDF page number (1-based), if this came from a PDF split. */
  sourcePdfPage?: number;
}

async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
  // `imageOrientation: 'from-image'` bakes the EXIF orientation into the
  // pixels. The browser canvas otherwise ignores EXIF, so a portrait phone
  // photo with an orientation flag would land sideways in the JPEG we ship
  // to the OCR worker. (Native capture already pre-rotates via Capacitor's
  // `correctOrientation`, so this mainly fixes the web file-picker path.)
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/jpeg',
      JPEG_QUALITY,
    ),
  );
}

async function bitmapToJpeg(
  bitmap: ImageBitmap,
  targetWidth: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, targetWidth / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire 2D canvas context');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvasToJpeg(canvas);
  return { blob, width, height };
}

/**
 * Draw `bitmap` rotated by `quarterTurns` × 90° clockwise, downscaled so
 * the *rotated* width is at most `targetWidth`, and re-encode as JPEG. Used
 * by the manual page-rotate control in the grouping UI.
 */
async function bitmapToRotatedJpeg(
  bitmap: ImageBitmap,
  quarterTurns: number,
  targetWidth: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const turns = ((quarterTurns % 4) + 4) % 4;
  const swap = turns === 1 || turns === 3;
  const rotW = swap ? bitmap.height : bitmap.width;
  const scale = Math.min(1, targetWidth / rotW);
  const outW = Math.round((swap ? bitmap.height : bitmap.width) * scale);
  const outH = Math.round((swap ? bitmap.width : bitmap.height) * scale);
  const drawW = Math.round(bitmap.width * scale);
  const drawH = Math.round(bitmap.height * scale);
  const canvas = makeCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire 2D canvas context');
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
  const blob = await canvasToJpeg(canvas);
  return { blob, width: outW, height: outH };
}

/**
 * Re-render an already-prepared page image rotated by `quarterTurns` × 90°
 * clockwise, producing a fresh full-size + thumbnail JPEG pair. Honors EXIF
 * on decode so a re-rotate composes correctly.
 */
export async function rotateImageBlob(blob: Blob, quarterTurns: number): Promise<PreparedPage> {
  const bitmap = await blobToImageBitmap(blob);
  try {
    const full = await bitmapToRotatedJpeg(bitmap, quarterTurns, PAGE_WIDTH);
    const thumb = await bitmapToRotatedJpeg(bitmap, quarterTurns, THUMB_WIDTH);
    return {
      fullJpeg: full.blob,
      thumbJpeg: thumb.blob,
      width: full.width,
      height: full.height,
    };
  } finally {
    bitmap.close();
  }
}

export async function prepareImage(file: File): Promise<PreparedPage> {
  const bitmap = await blobToImageBitmap(file);
  try {
    const full = await bitmapToJpeg(bitmap, PAGE_WIDTH);
    const thumb = await bitmapToJpeg(bitmap, THUMB_WIDTH);
    return {
      fullJpeg: full.blob,
      thumbJpeg: thumb.blob,
      width: full.width,
      height: full.height,
    };
  } finally {
    bitmap.close();
  }
}

export async function renderPdfToJpegs(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<PreparedPage[]> {
  const pdfjs = await import('pdfjs-dist');
  // Vite resolves the worker URL at build time via the ?url query. We
  // can't import the worker statically because pdfjs-dist ships an ESM
  // worker that has to run off the main thread.
  const workerMod = await import(/* @vite-ignore */ 'pdfjs-dist/build/pdf.worker.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: PreparedPage[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const scale = PAGE_WIDTH / viewport.width;
    const scaled = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(scaled.width);
    canvas.height = Math.round(scaled.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not acquire 2D canvas context for PDF render');
    await page.render({ canvasContext: ctx, viewport: scaled }).promise;
    const fullBlob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('PDF page toBlob returned null'))),
        'image/jpeg',
        JPEG_QUALITY,
      ),
    );
    // Render thumb from the same canvas to avoid a second decode.
    const thumbCanvas = document.createElement('canvas');
    const ratio = THUMB_WIDTH / canvas.width;
    thumbCanvas.width = THUMB_WIDTH;
    thumbCanvas.height = Math.round(canvas.height * ratio);
    const tctx = thumbCanvas.getContext('2d');
    if (!tctx) throw new Error('Could not acquire 2D canvas context for thumb');
    tctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumbBlob = await new Promise<Blob>((resolve, reject) =>
      thumbCanvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Thumb toBlob returned null'))),
        'image/jpeg',
        JPEG_QUALITY,
      ),
    );
    pages.push({
      fullJpeg: fullBlob,
      thumbJpeg: thumbBlob,
      width: canvas.width,
      height: canvas.height,
      sourcePdfPage: i,
    });
    onProgress?.(i, doc.numPages);
    page.cleanup();
  }
  await doc.cleanup();
  await doc.destroy();
  return pages;
}
