// Client-side collection-cover collage.
//
// Builds a collection cover from 1 or 4 of its recipes' cover images, composed
// on a canvas at the collection-cover aspect ratio (2:3 portrait, the shape
// CoverImageEditor / CoverImage render). One cover fills the frame
// (object-cover crop); four tile a 2x2 grid. An optional title is burned into a
// gradient band at the bottom. The result is a WebP blob (JPEG fallback for
// runtimes whose canvas can't encode WebP) ready for `uploadCollectionCover`.
//
// Pure compositing only — no network beyond fetching the public cover URLs.

import { supabase } from '../supabase.js';
import { COVER_QUALITY } from '../recipe/coverImage.js';

/** 2:3 portrait — matches the collection-cover display aspect. Longest edge
 *  stays under COVER_MAX_EDGE (1280) so it round-trips through prepareCoverImage
 *  without a second downscale. */
const COVER_W = 800;
const COVER_H = 1200;

const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

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
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      type,
      quality,
    ),
  );
}

/** Top-left coordinates + size for each cell, given how many covers we tile. */
export function collageCells(
  count: number,
): Array<{ x: number; y: number; w: number; h: number }> {
  if (count >= 4) {
    const cw = COVER_W / 2;
    const ch = COVER_H / 2;
    return [
      { x: 0, y: 0, w: cw, h: ch },
      { x: cw, y: 0, w: cw, h: ch },
      { x: 0, y: ch, w: cw, h: ch },
      { x: cw, y: ch, w: cw, h: ch },
    ];
  }
  return [{ x: 0, y: 0, w: COVER_W, h: COVER_H }];
}

async function loadCover(path: string): Promise<ImageBitmap> {
  const { data } = supabase.storage.from('covers').getPublicUrl(path);
  const resp = await fetch(data.publicUrl);
  if (!resp.ok) throw new Error(`cover fetch failed (${resp.status})`);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** object-cover: scale the bitmap to fill the cell, center-cropping overflow. */
function drawCovered(
  ctx: Ctx2D,
  bmp: ImageBitmap,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const scale = Math.max(dw / bmp.width, dh / bmp.height);
  const sw = dw / scale;
  const sh = dh / scale;
  const sx = (bmp.width - sw) / 2;
  const sy = (bmp.height - sh) / 2;
  ctx.drawImage(bmp, sx, sy, sw, sh, dx, dy, dw, dh);
}

/** Greedy word-wrap into at most `maxLines` lines that each fit `maxWidth`. */
function wrapLines(ctx: Ctx2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  // Ellipsize the last line if we ran out of room mid-title.
  const consumed = lines.join(' ').split(/\s+/).filter(Boolean).length;
  if (consumed < words.length && lines.length) {
    let last = lines[lines.length - 1]!;
    while (last && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.replace(/\s*\S$/, '');
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function drawTitleOverlay(ctx: Ctx2D, text: string): void {
  const maxWidth = COVER_W * 0.86;
  // Shrink the font until the title wraps to <= 3 lines.
  let fontSize = 92;
  let lines: string[];
  for (;;) {
    ctx.font = `700 ${fontSize}px ${FONT_STACK}`;
    lines = wrapLines(ctx, text, maxWidth, 3);
    if (lines.length <= 3 || fontSize <= 44) break;
    fontSize -= 8;
  }
  const lineHeight = fontSize * 1.16;
  const bandH = Math.min(COVER_H * 0.46, lineHeight * lines.length + COVER_H * 0.12);
  const grad = ctx.createLinearGradient(0, COVER_H - bandH, 0, COVER_H);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.82)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, COVER_H - bandH, COVER_W, bandH);

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10;
  const bottomPad = COVER_H * 0.06;
  lines.forEach((line, i) => {
    const y = COVER_H - bottomPad - (lines.length - 1 - i) * lineHeight;
    ctx.fillText(line, COVER_W / 2, y);
  });
  ctx.shadowBlur = 0;
}

export interface CollageOptions {
  /** Storage paths (in the `covers` bucket) of the chosen recipe covers — 1 or 4. */
  coverPaths: readonly string[];
  /** Optional title burned into a bottom gradient band (e.g. the collection title). */
  overlayText?: string;
}

/**
 * Compose a collection cover from the given recipe-cover paths and return the
 * encoded image blob. Throws if no covers load.
 */
export async function buildCollectionCoverCollage(opts: CollageOptions): Promise<Blob> {
  const paths = opts.coverPaths.slice(0, 4);
  if (paths.length === 0) throw new Error('No recipe covers selected for the collage.');

  const canvas = makeCanvas(COVER_W, COVER_H);
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) throw new Error('Could not acquire 2D canvas context');

  // Neutral backdrop shows through if a cover fails to load.
  ctx.fillStyle = '#1c1917';
  ctx.fillRect(0, 0, COVER_W, COVER_H);

  const bitmaps = await Promise.all(paths.map(loadCover));
  try {
    const cells = collageCells(bitmaps.length);
    bitmaps.forEach((bmp, i) => {
      const cell = cells[Math.min(i, cells.length - 1)]!;
      drawCovered(ctx, bmp, cell.x, cell.y, cell.w, cell.h);
    });
  } finally {
    bitmaps.forEach((b) => b.close());
  }

  const overlay = opts.overlayText?.trim();
  if (overlay) drawTitleOverlay(ctx, overlay);

  let blob = await encode(canvas, 'image/webp', COVER_QUALITY);
  if (blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', COVER_QUALITY);
  return blob;
}
