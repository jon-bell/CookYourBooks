import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { supabase } from '../supabase.js';

/**
 * Client for the `pdf-import` Edge Function: send the page images of a shared
 * PDF (plus the source URL read from its print header/footer) and get back one
 * parsed recipe draft. The user's Gemini key lives in Vault and is resolved
 * server-side, so it never reaches this bundle. Mirrors `videoImport.ts`.
 */

const FUNCTION_PATH = '/functions/v1/pdf-import';

export interface PdfImportResult {
  /** Source URL (from the PDF text layer, or the model's header/footer read). */
  sourceUrl: string | null;
  /** Display title for the per-site collection, e.g. the source host. */
  platformTitle: string;
  drafts: ParsedRecipeDraft[];
}

export type PdfImportErrorCode = 'NO_GEMINI_KEY' | 'EXTRACTION_FAILED' | 'UNKNOWN';

export class PdfImportError extends Error {
  constructor(
    public code: PdfImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PdfImportError';
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunk to stay clear of String.fromCharCode arg limits on large pages.
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Extract a single recipe from the rendered pages of a shared PDF. `pages` are
 * JPEG blobs (e.g. the `fullJpeg` from `renderPdfToJpegs`), in page order.
 */
export async function extractRecipeFromPdf(
  pages: Blob[],
  opts: { sourceUrl?: string | null } = {},
): Promise<PdfImportResult> {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new PdfImportError('UNKNOWN', 'Sign in to import a PDF.');

  const base64Pages = await Promise.all(pages.map(blobToBase64));

  const endpoint = `${import.meta.env.VITE_SUPABASE_URL}${FUNCTION_PATH}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (anonKey) headers.apikey = anonKey;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pages: base64Pages, sourceUrl: opts.sourceUrl ?? null }),
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const code = (json.code as PdfImportErrorCode) ?? 'UNKNOWN';
    const message = (json.error as string) ?? `pdf-import ${resp.status}`;
    throw new PdfImportError(code, message);
  }
  return json as unknown as PdfImportResult;
}
