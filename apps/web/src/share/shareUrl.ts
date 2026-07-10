// Helpers for generating absolute share URLs and copying them to the
// clipboard. Separate from `share.ts` (Markdown-blob sharing) because
// this surface is specifically about the *link* — the thing a user
// would paste into a chat or email for a friend to open.

/** Production web origin baked into share links minted from contexts whose
 *  own origin nobody else can open (the Capacitor app's is
 *  `capacitor://localhost`). */
const CANONICAL_ORIGIN = 'https://cookyourbooks.app';

function isNativePlatform(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/**
 * The origin share links are minted against. A real http(s) browser origin
 * is used as-is — dev (`http://localhost:5173`) and preview deploys keep
 * producing links that open in that same environment (the share-link e2e
 * depends on this). The native app — and any non-http(s) origin — gets the
 * canonical production domain instead: `capacitor://localhost/r/…` is a
 * link nobody else can open. `VITE_SHARE_ORIGIN` overrides for staging.
 */
export function shareOrigin(): string {
  const override = import.meta.env.VITE_SHARE_ORIGIN as string | undefined;
  if (override) return override.replace(/\/+$/, '');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  if (!isNativePlatform() && /^https?:\/\//i.test(origin)) return origin;
  return CANONICAL_ORIGIN;
}

/**
 * Build an absolute URL at a given path against {@link shareOrigin}.
 * Callers passing a fully-qualified URL get it back unchanged.
 */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${shareOrigin()}${clean}`;
}

export function recipeShareUrl(collectionId: string, recipeId: string): string {
  return absoluteUrl(`/collections/${collectionId}/recipes/${recipeId}`);
}

/** The short share link: just the recipe uuid. Resolves via /r/:recipeId for
 *  the owner, household co-members, and (when the collection is public)
 *  anyone — including signed-out visitors. */
export function bareRecipeShareUrl(recipeId: string): string {
  return absoluteUrl(`/r/${recipeId}`);
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
