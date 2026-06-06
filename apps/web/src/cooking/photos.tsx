import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { prepareImage } from '../import/imageProcessing.js';

const BUCKET = 'cooking-photos';
const SIGN_TTL_SECONDS = 60 * 60;
const cache = new Map<string, { url: string; expires: number }>();

/**
 * Compress + upload one photo for a cooking event. Stored under
 * `<ownerId>/<eventId>/<uuid>.jpg` so the per-owner storage RLS (and the
 * household-read policy keyed on the first folder segment) apply. Returns
 * the storage path to persist on the event.
 */
export async function uploadCookingPhoto(
  ownerId: string,
  eventId: string,
  file: File,
): Promise<string> {
  const prepared = await prepareImage(file);
  const path = `${ownerId}/${eventId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, prepared.fullJpeg, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;
  return path;
}

/**
 * Remove photos from the bucket (best-effort). Called when an entry is
 * deleted so the bytes don't orphan. RLS only lets the owner delete their
 * own folder, so passing a co-member's path is a harmless no-op.
 */
export async function deleteCookingPhotos(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  for (const p of paths) cache.delete(p);
  const { error } = await supabase.storage.from(BUCKET).remove([...paths]);
  if (error) throw error;
}

export async function getSignedCookingPhotoUrl(path: string): Promise<string> {
  const now = Date.now();
  const cached = cache.get(path);
  if (cached && cached.expires > now + 60_000) return cached.url;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGN_TTL_SECONDS);
  if (error || !data?.signedUrl) throw error ?? new Error('signed URL failed');
  cache.set(path, { url: data.signedUrl, expires: now + SIGN_TTL_SECONDS * 1000 });
  return data.signedUrl;
}

/** Thumbnail for a stored cooking photo (signs the path on mount). */
export function CookingPhotoThumb({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | undefined>();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSignedCookingPhotoUrl(path)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setErrored(true));
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (errored) {
    return (
      <div
        className={`flex items-center justify-center bg-stone-100 text-xs text-stone-400 dark:bg-stone-800 ${className ?? ''}`}
      >
        ✕
      </div>
    );
  }
  if (!url) return <div className={`bg-stone-100 dark:bg-stone-800 ${className ?? ''}`} />;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Cooking photo" loading="lazy" className={className} data-testid="cook-photo" />
    </a>
  );
}
