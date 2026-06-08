// "Social card" sharing for the gallery. Unlike `share.ts` (which shares the
// recipe as Markdown text) this composes the *card itself* — the cover photo
// (or a gradient when there's none) with the recipe title baked across the
// bottom — into a PNG and hands it to the platform share sheet. The shared
// artifact therefore still carries the recipe when posted as a bare image to a
// social feed. Where the Web Share file API is unavailable it downloads the
// PNG and copies the link instead.

import { supabase } from '../supabase.js';
import { copyToClipboard } from './shareUrl.js';

export type ShareCardOutcome = 'shared' | 'downloaded' | 'cancelled';

// 3:2, matching the gallery cards and the cover-generation prompt.
const CARD_W = 1200;
const CARD_H = 800;

export interface SocialCardInput {
  title: string;
  /** Storage path in the public `covers` bucket; absent → gradient card. */
  coverImagePath?: string;
  /** Absolute recipe URL, included in the share text. */
  url: string;
}

export async function shareRecipeSocialCard(input: SocialCardInput): Promise<ShareCardOutcome> {
  const blob = await composeCard(input);
  const filename = `${slugify(input.title)}.png`;
  const text = `${input.title}\n${input.url}`;

  // Web Share Level 2 (files): the native sheet on mobile Safari/Chrome and
  // recent iOS WKWebView. Must run inside the click's user-gesture window.
  const file = typeof File !== 'undefined' ? new File([blob], filename, { type: 'image/png' }) : null;
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (
    file &&
    nav &&
    typeof nav.canShare === 'function' &&
    nav.canShare({ files: [file] }) &&
    typeof nav.share === 'function'
  ) {
    try {
      await nav.share({ files: [file], title: input.title, text });
      return 'shared';
    } catch (err) {
      if (isCancellation(err)) return 'cancelled';
      // Any other failure → fall through to the download.
    }
  }

  downloadBlob(blob, filename);
  void copyToClipboard(input.url);
  return 'downloaded';
}

async function composeCard(input: SocialCardInput): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');

  const bitmap = input.coverImagePath ? await loadCover(input.coverImagePath) : null;
  if (bitmap) {
    drawCover(ctx, bitmap);
    bitmap.close();
  } else {
    drawGradient(ctx, '#57534e', '#1c1917'); // stone-600 → stone-900
  }

  // Bottom scrim so the title reads over any photo.
  const scrim = ctx.createLinearGradient(0, CARD_H * 0.45, 0, CARD_H);
  scrim.addColorStop(0, 'rgba(0,0,0,0)');
  scrim.addColorStop(1, 'rgba(0,0,0,0.72)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  drawWordmark(ctx);
  drawTitle(ctx, input.title);

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed.'))), 'image/png'),
  );
}

/** Fetch + decode the public cover. Returns null on CORS/network/decode error
 *  so the card falls back to a gradient rather than failing the whole share. */
async function loadCover(path: string): Promise<ImageBitmap | null> {
  try {
    const { data } = supabase.storage.from('covers').getPublicUrl(path);
    const resp = await fetch(data.publicUrl, { mode: 'cors' });
    if (!resp.ok) return null;
    return await createImageBitmap(await resp.blob());
  } catch {
    return null;
  }
}

/** object-cover: scale to fill the card, center-cropping the overflow. */
function drawCover(ctx: CanvasRenderingContext2D, bmp: ImageBitmap): void {
  const scale = Math.max(CARD_W / bmp.width, CARD_H / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.drawImage(bmp, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h);
}

function drawGradient(ctx: CanvasRenderingContext2D, from: string, to: string): void {
  const g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

function drawTitle(ctx: CanvasRenderingContext2D, title: string): void {
  const size = 64;
  ctx.font = `700 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  const lines = wrapLines(ctx, title, CARD_W - 96, 3);
  const lineHeight = size * 1.15;
  let y = CARD_H - 56 - (lines.length - 1) * lineHeight;
  for (const line of lines) {
    ctx.fillText(line, 48, y);
    y += lineHeight;
  }
}

function drawWordmark(ctx: CanvasRenderingContext2D): void {
  ctx.font = '600 28px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.textBaseline = 'top';
  ctx.fillText('CookYourBooks', 48, 44);
}

/** Greedy word-wrap to `maxLines`, ellipsizing the last line on overflow. */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    // `!cur` guarantees at least one word per line even if it overflows.
    if (!cur || ctx.measureText(trial).width <= maxWidth) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1] ?? '';
  while (last.length > 0 && ctx.measureText(`${last}…`).width > maxWidth) {
    last = last.slice(0, -1).trimEnd();
  }
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slugify(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'recipe'
  );
}

function isCancellation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name ?? '';
  const message = String((err as { message?: string }).message ?? '');
  return name === 'AbortError' || /cancel|denied|abort/i.test(message);
}
