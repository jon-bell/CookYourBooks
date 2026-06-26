import { useEffect, useState } from 'react';

import { supabase } from '../supabase.js';

interface Props {
  path: string | null;
  alt?: string;
  className?: string;
}

const cache = new Map<string, { url: string; expires: number }>();
const SIGN_TTL_SECONDS = 60 * 60;

async function signedUrl(path: string): Promise<string> {
  const now = Date.now();
  const cached = cache.get(path);
  if (cached && cached.expires > now + 60_000) return cached.url;
  const { data, error } = await supabase.storage
    .from('imports')
    .createSignedUrl(path, SIGN_TTL_SECONDS);
  if (error || !data?.signedUrl) throw error ?? new Error('signed URL failed');
  cache.set(path, { url: data.signedUrl, expires: now + SIGN_TTL_SECONDS * 1000 });
  return data.signedUrl;
}

export function ImportThumb({ path, alt, className }: Props) {
  const [url, setUrl] = useState<string | undefined>();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!path) return;
    void signedUrl(path)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!path || errored) {
    return (
      <div
        className={`flex items-center justify-center bg-stone-100 text-xs text-stone-500 ${className ?? ''}`}
      >
        no preview
      </div>
    );
  }
  if (!url) return <div className={`bg-stone-100 ${className ?? ''}`} />;
  return <img src={url} alt={alt ?? ''} loading="lazy" className={className} />;
}

export async function getSignedImportUrl(path: string): Promise<string> {
  return signedUrl(path);
}

/**
 * Forget the cached signed URL for a path so the next `signedUrl` /
 * `getSignedImportUrl` re-signs it. After overwriting an object in place
 * (e.g. a manual page rotate re-uploads to the same path), re-signing
 * yields a URL with a fresh token query, which also defeats the browser /
 * CDN image cache for the old bytes.
 */
export function bustSignedUrl(path: string): void {
  cache.delete(path);
}
