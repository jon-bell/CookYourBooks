// Extract the source URL that "Print to PDF" stamps into a page's header /
// footer. When an iOS user prints a paywalled recipe (e.g. NYT Cooking) to PDF
// from Safari and shares it to CookYourBooks, Safari embeds a real *text layer*
// containing the page title (header) and the page URL + date + "page N of M"
// (footer). We read that text layer with pdfjs — free and far more reliable
// than OCR — and recover the URL so the imported recipe links back to its
// origin. Scanned/image-only PDFs have no text layer and degrade to null (the
// import flow then falls back to the OCR LLM, or saves with no source URL).

/** The shape of a pdfjs text-content item we care about. pdfjs also yields
 *  marked-content items without `str`/`transform`; those are ignored. */
interface TextItemLike {
  str: string;
  transform: number[];
}

/** Trim trailing punctuation a footer often appends after the URL. */
function trimUrl(u: string): string {
  return u.replace(/[.,;:!?)\]}'"»]+$/, '');
}

/** First http(s) URL in a blob of text, with a `www.`-prefixed fallback. */
function firstUrlIn(text: string): string | null {
  const m = /\bhttps?:\/\/\S+/i.exec(text);
  if (m) return trimUrl(m[0]);
  const w = /\bwww\.\S+\.\S+/i.exec(text);
  if (w) return trimUrl(`https://${w[0]}`);
  return null;
}

/**
 * Pure band-scan: given a page's text items and its height (PDF user units,
 * origin bottom-left), return the first URL found in the footer band (bottom
 * ~12%) — where Safari prints the page URL — else the header band (top ~12%).
 * Split out so it can be unit-tested without loading pdfjs.
 */
export function findSourceUrlInItems(
  items: readonly TextItemLike[],
  pageHeight: number,
): string | null {
  const top: string[] = [];
  const bottom: string[] = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !Array.isArray(it.transform)) continue;
    const y = it.transform[5];
    if (typeof y !== 'number') continue;
    if (y >= pageHeight * 0.88) top.push(it.str);
    else if (y <= pageHeight * 0.12) bottom.push(it.str);
  }
  return firstUrlIn(bottom.join(' ')) ?? firstUrlIn(top.join(' '));
}

/**
 * Read a PDF's text layer and return the source URL printed in its header /
 * footer, or null when none is present. Scans the first page and (if multi-page)
 * the last page. Never throws — returns null on any pdfjs / parse failure.
 */
export async function extractSourceUrlFromPdf(file: File): Promise<string | null> {
  try {
    const pdfjs = await import('pdfjs-dist');
    // Same worker wiring as renderPdfToJpegs — Vite resolves the ESM worker
    // URL at build time via the ?url query.
    const workerMod = (await import(
      /* @vite-ignore */ 'pdfjs-dist/build/pdf.worker.mjs?url'
    )) as { default: string };
    pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default;

    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    try {
      const pages = doc.numPages <= 1 ? [1] : [1, doc.numPages];
      for (const n of pages) {
        const page = await doc.getPage(n);
        const height = page.getViewport({ scale: 1 }).height;
        const content = await page.getTextContent();
        const found = findSourceUrlInItems(content.items as TextItemLike[], height);
        page.cleanup();
        if (found) return found;
      }
      return null;
    } finally {
      await doc.cleanup();
      await doc.destroy();
    }
  } catch {
    return null;
  }
}
