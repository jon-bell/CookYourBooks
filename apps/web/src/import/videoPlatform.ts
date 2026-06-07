// Browser-side twin of `detectPlatform` in
// `supabase/functions/video-import/index.ts`. Kept in sync by hand — the
// edge function can't import web code and vice versa. Used to validate a
// shared/pasted URL before handing it to the import flow.

export type VideoPlatform = 'youtube' | 'tiktok' | 'instagram';

export function detectVideoPlatform(url: string): VideoPlatform | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    return 'youtube';
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  return null;
}

/**
 * Pull the first supported video URL out of an arbitrary shared string.
 * Share sheets often deliver "Check this out https://… #foo" rather than a
 * bare URL, so we scan tokens and return the first that resolves to a known
 * platform. Returns null when nothing matches.
 */
export function firstVideoUrl(shared: string | null | undefined): string | null {
  if (!shared) return null;
  for (const token of shared.split(/\s+/)) {
    const candidate = token.trim();
    if (candidate && detectVideoPlatform(candidate)) return candidate;
  }
  return detectVideoPlatform(shared.trim()) ? shared.trim() : null;
}
