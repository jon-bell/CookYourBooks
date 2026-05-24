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
  return createImageBitmap(blob);
}

async function bitmapToJpeg(
  bitmap: ImageBitmap,
  targetWidth: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, targetWidth / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : (() => {
          const c = document.createElement('canvas');
          c.width = width;
          c.height = height;
          return c;
        })();
  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('Could not acquire 2D canvas context');
  ctx.drawImage(bitmap, 0, 0, width, height);
  let blob: Blob;
  if (canvas instanceof OffscreenCanvas) {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  } else {
    blob = await new Promise<Blob>((resolve, reject) =>
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
        'image/jpeg',
        JPEG_QUALITY,
      ),
    );
  }
  return { blob, width, height };
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
  const workerMod = (await import(
    /* @vite-ignore */ 'pdfjs-dist/build/pdf.worker.mjs?url'
  )) as { default: string };
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
