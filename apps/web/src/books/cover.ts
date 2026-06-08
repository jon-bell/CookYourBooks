import { supabase } from '../supabase.js';
import { COVER_CACHE_CONTROL, coverObjectKey, prepareCoverImage } from '../recipe/coverImage.js';

// Shared cover-upload helper for a user's own collection. Mirrors the path
// and upsert posture used by CoverImageEditor (`<user>/collections/<id>-<hash>.<ext>`)
// so a cover set here and one set in the editor are interchangeable. Used to
// persist an Open Library cover blob onto a freshly-created cookbook.

/**
 * Downscales + re-encodes `blob`, uploads it as the cover for `collectionId`
 * owned by `userId`, and returns the content-addressed storage path to store
 * in `coverImagePath`. Removes `previousPath` when the new key differs so a
 * replaced cover doesn't orphan bytes.
 */
export async function uploadCollectionCover(
  userId: string,
  collectionId: string,
  blob: Blob,
  previousPath?: string,
): Promise<string> {
  const prepared = await prepareCoverImage(blob);
  const path = await coverObjectKey(
    `${userId}/collections`,
    collectionId,
    await prepared.blob.arrayBuffer(),
    prepared.ext,
  );
  const { error } = await supabase.storage
    .from('covers')
    .upload(path, prepared.blob, {
      upsert: true,
      contentType: prepared.contentType,
      cacheControl: COVER_CACHE_CONTROL,
    });
  if (error) throw error;
  if (previousPath && previousPath !== path) {
    await supabase.storage.from('covers').remove([previousPath]);
  }
  return path;
}
