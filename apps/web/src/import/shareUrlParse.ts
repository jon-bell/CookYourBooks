import { detectVideoPlatform, firstHttpUrl, firstVideoUrl, type VideoPlatform } from './videoPlatform.js';

// Pure parsing for share-intent payloads — split out of shareIntent.ts so it
// can be unit-tested without pulling in the native/Sentry bridge.

export interface ParsedIntent {
  url: string | null;
  /** null = generic website (any non-social http(s) link). */
  platform: VideoPlatform | null;
}

/** Resolve a candidate string to a usable URL — preferring a supported video
 *  platform, falling back to any http(s) link (a generic recipe site). */
export function classify(candidate: string): ParsedIntent | null {
  const video = firstVideoUrl(candidate);
  if (video) return { url: video, platform: detectVideoPlatform(video) };
  const http = firstHttpUrl(candidate);
  if (http) return { url: http, platform: null };
  return null;
}

/**
 * Pull a usable URL out of a `SendIntent` / `appUrlOpen` payload, plus
 * whether it's from a supported video platform (null = generic website).
 *
 * Two payload shapes:
 *   - `appUrlOpen`: `{ url: 'cookyourbooks://?url=…&title=…&description=…' }`
 *     — the share params are embedded in the deep link's query string.
 *   - `SendIntent`: `{ url, title, type, … }` — share params are top-level.
 *
 * The native share extension only fills `url` for a `public.url` attachment;
 * when a host app shares a link as plain text it lands in `title` (or
 * `description`) with `url` empty — so we scan all three in both shapes.
 */
export function urlFromIntent(payload: unknown): ParsedIntent {
  if (!payload || typeof payload !== 'object') return { url: null, platform: null };
  const obj = payload as Record<string, unknown>;
  const raw = typeof obj.url === 'string' ? obj.url : undefined;
  if (raw) {
    if (/^cookyourbooks:/i.test(raw)) {
      try {
        const params = new URL(raw).searchParams;
        for (const key of ['url', 'title', 'description']) {
          const embedded = params.get(key);
          if (embedded) {
            const c = classify(embedded);
            if (c) return c;
          }
        }
      } catch {
        /* fall through */
      }
    }
    const c = classify(raw);
    if (c) return c;
  }
  if (typeof obj.title === 'string') {
    const c = classify(obj.title);
    if (c) return c;
  }
  return { url: null, platform: null };
}
