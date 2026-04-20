// Helpers for generating absolute share URLs and copying them to the
// clipboard. Separate from `share.ts` (Markdown-blob sharing) because
// this surface is specifically about the *link* — the thing a user
// would paste into a chat or email for a friend to open.

/**
 * Build an absolute URL for the currently-running app at a given path.
 * Falls back to `location.origin` when running in the browser; callers
 * passing a fully-qualified URL get it back unchanged.
 */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : '';
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${clean}`;
}

export function recipeShareUrl(collectionId: string, recipeId: string): string {
  return absoluteUrl(`/collections/${collectionId}/recipes/${recipeId}`);
}

export function collectionShareUrl(collectionId: string): string {
  return absoluteUrl(`/collections/${collectionId}`);
}

/**
 * Copy a string to the clipboard. Prefers the async Clipboard API; on
 * older / insecure contexts falls back to a one-shot textarea trick.
 * Returns true on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea path — some browsers throw when
      // the document isn't focused (e.g. Playwright in headless mode
      // without a user gesture).
    }
  }
  if (typeof document === 'undefined') return false;
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.top = '-1000px';
  document.body.appendChild(el);
  el.select();
  try {
    const ok = document.execCommand('copy');
    return ok;
  } catch {
    return false;
  } finally {
    document.body.removeChild(el);
  }
}
