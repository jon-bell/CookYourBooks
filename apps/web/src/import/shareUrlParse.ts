import {
  detectVideoPlatform,
  firstHttpUrl,
  firstVideoUrl,
  type VideoPlatform,
} from './videoPlatform.js';

// Pure parsing for share-intent payloads — split out of shareIntent.ts so it
// can be unit-tested without pulling in the native/Sentry bridge.

export interface ParsedIntent {
  url: string | null;
  /** null = generic website (any non-social http(s) link). */
  platform: VideoPlatform | null;
}

/** Yield the candidate as-is, then progressively percent-decoded forms.
 *  The as-is form is tried first, so a URL that *legitimately* contains
 *  percent-escapes (e.g. `…/a%20b`) matches immediately and is never
 *  over-decoded. Only when nothing matched do we decode again — to
 *  recover URLs that arrived single- or double-encoded. (Older iOS
 *  share-extension builds double-encoded the deep-link query, landing a
 *  value like `https%3A%2F%2F…` after one decode — Sentry
 *  CYB-CAPACITOR-D.) Bounded to a few rounds; stops when a round changes
 *  nothing or there are no `%xx` escapes left. */
function* decodeVariants(s: string): Generator<string> {
  let cur = s;
  yield cur;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(cur); i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return;
    }
    if (next === cur) return;
    cur = next;
    yield cur;
  }
}

/** Resolve a candidate string to a usable URL — preferring a supported video
 *  platform, falling back to any http(s) link (a generic recipe site). */
export function classify(candidate: string): ParsedIntent | null {
  for (const variant of decodeVariants(candidate)) {
    const video = firstVideoUrl(variant);
    if (video) return { url: video, platform: detectVideoPlatform(video) };
    const http = firstHttpUrl(variant);
    if (http) return { url: http, platform: null };
  }
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
