import { useEffect, useState } from 'react';

import { prepareImage } from '../import/imageProcessing.js';
import { supabase } from '../supabase.js';

const BUCKET = 'cooking-photos';
const SIGN_TTL_SECONDS = 60 * 60;
const cache = new Map<string, { url: string; expires: number }>();

/** Transform width for the 64px (h-16 w-16) thumbnail — 2x retina. Full phone
 *  photos are multi-MP; serving a 128px crop keeps the gallery cheap. */
const THUMB_WIDTH = 128;
/** Generous cap for the full-size view opened from a thumbnail. */
const FULL_WIDTH = 1280;

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
  // Evict both the bare-path entry and any width-keyed (`<path>@<width>`)
  // transform variants cached for it.
  const drop = new Set(paths);
  for (const key of cache.keys()) {
    if (drop.has(key) || drop.has(key.replace(/@\d+$/, ''))) cache.delete(key);
  }
  const { error } = await supabase.storage.from(BUCKET).remove([...paths]);
  if (error) throw error;
}

/**
 * Sign a cooking-photo path, optionally requesting a CDN-cached on-the-fly
 * resize. `width` sizes down the rendered bytes (e.g. tiny thumbnails) without
 * downloading the full multi-MP phone photo; omit it for full resolution.
 * Cached in-memory per (path, width) until shortly before expiry.
 */
export async function getSignedCookingPhotoUrl(path: string, width?: number): Promise<string> {
  const now = Date.now();
  const key = width === undefined ? path : `${path}@${width}`;
  const cached = cache.get(key);
  if (cached && cached.expires > now + 60_000) return cached.url;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(
      path,
      SIGN_TTL_SECONDS,
      width === undefined ? undefined : { transform: { width } },
    );
  if (error || !data?.signedUrl) throw error ?? new Error('signed URL failed');
  cache.set(key, { url: data.signedUrl, expires: now + SIGN_TTL_SECONDS * 1000 });
  return data.signedUrl;
}

/** Thumbnail for a stored cooking photo (signs the path on mount). */
export function CookingPhotoThumb({ path, className }: { path: string; className?: string }) {
  const [url, setUrl] = useState<string | undefined>();
  const [fullUrl, setFullUrl] = useState<string | undefined>();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Tiny resized crop for the rendered <img>; full-res for the open-in-new-tab
    // link. The full-res sign is lazy enough that it's fine to fetch alongside.
    void getSignedCookingPhotoUrl(path, THUMB_WIDTH)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setErrored(true));
    void getSignedCookingPhotoUrl(path, FULL_WIDTH)
      .then((u) => !cancelled && setFullUrl(u))
      .catch(() => {
        /* full-view link is best-effort; thumbnail error already covers UX */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (errored) {
    return (
      <div
        className={`flex items-center justify-center bg-stone-100 text-xs text-stone-400 dark:text-stone-500 dark:bg-stone-800 ${className ?? ''}`}
      >
        ✕
      </div>
    );
  }
  if (!url) return <div className={`bg-stone-100 dark:bg-stone-800 ${className ?? ''}`} />;
  return (
    <a href={fullUrl ?? url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt="Cooking photo"
        loading="lazy"
        className={className}
        data-testid="cook-photo"
      />
    </a>
  );
}
