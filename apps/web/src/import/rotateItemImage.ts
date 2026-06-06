import { supabase } from '../supabase.js';
import { rotateImageBlob } from './imageProcessing.js';
import { bustSignedUrl, getSignedImportUrl } from './ImportThumb.js';
import type { ImportItem } from './model.js';

async function uploadBlob(path: string, blob: Blob): Promise<void> {
  const { error } = await supabase.storage.from('imports').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) throw error;
}

/**
 * Rotate a page's stored image by `quarterTurns` × 90° clockwise and
 * overwrite the page + thumb objects in place. The OCR worker reads the
 * stored image and forwards it to the LLM, so the rotation has to be baked
 * into the bytes (not just a display transform) for OCR to benefit — hence
 * a download → rotate → re-upload rather than a metadata flag.
 *
 * Intended for the pre-OCR grouping stage (AWAITING_GROUPING items): the
 * worker hasn't read the page yet, so no OCR reset is needed. Busts the
 * cached signed URLs so callers re-fetch the rotated bytes.
 */
export async function rotateImportItemImage(
  item: Pick<ImportItem, 'storagePath' | 'thumbPath'>,
  quarterTurns: number,
): Promise<void> {
  const url = await getSignedImportUrl(item.storagePath);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Couldn't fetch page image (${resp.status})`);
  const current = await resp.blob();
  const rotated = await rotateImageBlob(current, quarterTurns);
  await uploadBlob(item.storagePath, rotated.fullJpeg);
  bustSignedUrl(item.storagePath);
  if (item.thumbPath) {
    await uploadBlob(item.thumbPath, rotated.thumbJpeg);
    bustSignedUrl(item.thumbPath);
  }
}
