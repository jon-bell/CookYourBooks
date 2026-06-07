import { supabase } from '../supabase.js';

// Shared cover-upload helper for a user's own collection. Mirrors the path
// and upsert posture used by CoverImageEditor (`<user>/collections/<id>.<ext>`)
// so a cover set here and one set in the editor are interchangeable. Used to
// persist an Open Library cover blob onto a freshly-created cookbook.

function extFor(blob: Blob, fallbackName?: string): string {
  const fromType = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  if (blob.type) return fromType;
  const fromName = fallbackName?.split('.').pop()?.toLowerCase();
  return fromName || 'jpg';
}

/**
 * Uploads `blob` as the cover for `collectionId` owned by `userId` and
 * returns the storage path to store in `coverImagePath`. Upserts so a
 * re-fetch replaces the previous cover.
 */
export async function uploadCollectionCover(
  userId: string,
  collectionId: string,
  blob: Blob,
  fallbackName?: string,
): Promise<string> {
  const path = `${userId}/collections/${collectionId}.${extFor(blob, fallbackName)}`;
  const { error } = await supabase.storage
    .from('covers')
    .upload(path, blob, { upsert: true, cacheControl: '3600' });
  if (error) throw error;
  return path;
}
