// Cross-platform share. On native Capacitor, opens the OS share sheet.
// On web we prefer `navigator.share` (Web Share API — Safari, Chrome on
// Android, Edge), and fall back to downloading a Markdown file when the
// browser doesn't support it.

export interface ShareRecipePayload {
  title: string;
  markdown: string;
  /** Filename for the download fallback; defaults to slugified title. */
  filename?: string;
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

export async function shareRecipe(payload: ShareRecipePayload): Promise<ShareOutcome> {
  const filename = payload.filename ?? slugify(payload.title);
  if (isCapacitorNative()) {
    return shareNative(payload);
  }
  if (canUseWebShare()) {
    return shareViaWebApi(payload);
  }
  downloadMarkdown(payload.markdown, filename);
  return 'downloaded';
}

function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'recipe'}.md`;
}

function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

function canUseWebShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

async function shareNative(payload: ShareRecipePayload): Promise<ShareOutcome> {
  try {
    const { Share } = await import('@capacitor/share');
    await Share.share({
      title: payload.title,
      text: payload.markdown,
      dialogTitle: 'Share recipe',
    });
    return 'shared';
  } catch (err) {
    if (isCancellation(err)) return 'cancelled';
    throw err;
  }
}

async function shareViaWebApi(payload: ShareRecipePayload): Promise<ShareOutcome> {
  try {
    await navigator.share({ title: payload.title, text: payload.markdown });
    return 'shared';
  } catch (err) {
    if (isCancellation(err)) return 'cancelled';
    // Treat any non-cancellation error as a fallback-worthy failure. Some
    // mobile browsers reject text-only shares; fall back to the download.
    downloadMarkdown(payload.markdown, payload.filename ?? slugify(payload.title));
    return 'downloaded';
  }
}

function downloadMarkdown(markdown: string, filename: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function isCancellation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name ?? '';
  const message = String((err as { message?: string }).message ?? '');
  return name === 'AbortError' || /cancel|denied|abort/i.test(message);
}
