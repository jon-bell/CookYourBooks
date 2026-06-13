import { detectVideoPlatform, firstHttpUrl, firstVideoUrl, type VideoPlatform } from './videoPlatform.js';

// Pure parsing for share-intent payloads — split out of shareIntent.ts so it
// can be unit-tested without pulling in the native/Sentry bridge.

export interface ParsedIntent {
  url: string | null;
  /** null = generic website (any non-social http(s) link). */
  platform: VideoPlatform | null;
}

/** A file shared from another app (e.g. a recipe printed to PDF, or a
 *  screenshot). The native share extension copies the file into the app group
 *  container and hands us a `file://` path + a `type` mime; the bytes are read
 *  on demand in the web layer via `import/sharedFile.ts`. */
export type SharedFileKind = 'pdf' | 'image';

/** Discriminated outcome of parsing a raw share payload.
 *  - `url`  — an http(s) recipe link (social platform or generic site).
 *  - `file` — a `file://` attachment (PDF / image) in the app group.
 *  - `none` — nothing usable; the caller surfaces actionable feedback. */
export type ParsedShare =
  | { kind: 'url'; url: string; platform: VideoPlatform | null }
  | { kind: 'file'; fileUrl: string; fileKind: SharedFileKind; name: string | null }
  | { kind: 'none' };

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

/** The four share fields, normalized out of either payload shape.
 *
 * Two payload shapes:
 *   - `appUrlOpen`: `{ url: 'cookyourbooks://?url=…&title=…&description=…&type=…' }`
 *     — the share params are embedded in the deep link's query string.
 *   - `SendIntent`: `{ url, title, description, type, … }` — params are top-level.
 *
 * For the embedded shape we read via `searchParams`, which decodes one layer of
 * percent-encoding (a `file://` path with `%20` for a space lands correctly,
 * and a double-encoded http link drops to a single layer for `classify` to
 * finish). The `type` field is what distinguishes a file attachment from a
 * plain link share — it was previously ignored entirely. */
interface ShareFields {
  url: string;
  title: string;
  description: string;
  type: string;
}

function normalize(payload: object): ShareFields {
  const obj = payload as Record<string, unknown>;
  const rawUrl = typeof obj.url === 'string' ? obj.url : '';
  if (/^cookyourbooks:/i.test(rawUrl)) {
    try {
      const p = new URL(rawUrl).searchParams;
      return {
        url: p.get('url') ?? '',
        title: p.get('title') ?? '',
        description: p.get('description') ?? '',
        type: p.get('type') ?? '',
      };
    } catch {
      /* fall through to the top-level read */
    }
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    url: rawUrl,
    title: str(obj.title),
    description: str(obj.description),
    type: str(obj.type),
  };
}

/** Classify a file attachment by its mime `type`, falling back to sniffing the
 *  extension off the `file://` path for hosts that hand over a bare type. */
function fileKindFor(type: string, url: string): SharedFileKind | null {
  const t = type.toLowerCase();
  if (t.startsWith('application/pdf')) return 'pdf';
  if (t.startsWith('image/')) return 'image';
  if (/^file:\/\//i.test(url)) {
    if (/\.pdf(\?|$)/i.test(url)) return 'pdf';
    if (/\.(png|jpe?g|heic|heif|webp|gif)(\?|$)/i.test(url)) return 'image';
  }
  return null;
}

/**
 * Parse a raw `SendIntent` / `appUrlOpen` payload into a discriminated outcome.
 * File attachments are recognized first (via the `type` mime); otherwise we
 * scan `url`, then `title`, then `description` for an http(s) recipe link. The
 * native share extension only fills `url` for a `public.url` attachment; when a
 * host shares a link as plain text it lands in `title` (or `description`) with
 * `url` empty — so all three are scanned.
 */
export function parseShareIntent(payload: unknown): ParsedShare {
  if (!payload || typeof payload !== 'object') return { kind: 'none' };
  const { url, title, description, type } = normalize(payload);

  // File attachment — discriminated by the mime type, requires a file:// path
  // we can later read from the app group container.
  if (/^file:\/\//i.test(url)) {
    const fileKind = fileKindFor(type, url);
    if (fileKind) return { kind: 'file', fileUrl: url, fileKind, name: title || null };
  }

  // Plain recipe link — scan the three text fields in priority order.
  for (const candidate of [url, title, description]) {
    if (!candidate) continue;
    const c = classify(candidate);
    if (c?.url) return { kind: 'url', url: c.url, platform: c.platform };
  }
  return { kind: 'none' };
}

/**
 * Back-compat thin wrapper around {@link parseShareIntent} returning just the
 * link outcome (file shares report `null`). Retained for existing callers/tests.
 */
export function urlFromIntent(payload: unknown): ParsedIntent {
  const parsed = parseShareIntent(payload);
  return parsed.kind === 'url'
    ? { url: parsed.url, platform: parsed.platform }
    : { url: null, platform: null };
}
