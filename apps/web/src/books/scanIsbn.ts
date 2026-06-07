import { supabase } from '../supabase.js';
import { normalizeIsbn } from './openLibrary.js';

// Client for the `isbn-scan` Edge Function: send a photo of a book's cover
// or barcode, get back the ISBN. The user's Gemini key lives in Vault and is
// resolved server-side (same posture as video-import), so it never reaches
// this bundle. We use LLM vision rather than the browser BarcodeDetector API
// because the latter isn't available in the iOS Capacitor WebView.

const FUNCTION_PATH = '/functions/v1/isbn-scan';

export type IsbnScanErrorCode = 'NO_GEMINI_KEY' | 'NO_ISBN_FOUND' | 'SCAN_FAILED' | 'UNKNOWN';

export class IsbnScanError extends Error {
  constructor(
    public code: IsbnScanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IsbnScanError';
  }
}

declare global {
  interface Window {
    /** E2E hook: short-circuits the edge call with a canned ISBN (or null).
     *  Mirrors `window.__cybScanShim` (see import/scanPages.ts). */
    __cybIsbnScanShim?: (file: Blob) => Promise<string | null>;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.onload = () => {
      const result = reader.result as string;
      // strip the `data:<mime>;base64,` prefix
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Sends `file` (a cover/barcode photo) to the scanner and returns the
 * detected, normalized ISBN, or null when none was found.
 */
export async function scanIsbnFromImage(file: Blob): Promise<string | null> {
  if (typeof window !== 'undefined' && window.__cybIsbnScanShim) {
    return window.__cybIsbnScanShim(file);
  }
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new IsbnScanError('UNKNOWN', 'Sign in to scan a book.');

  const imageBase64 = await blobToBase64(file);
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
    body: JSON.stringify({ imageBase64, mimeType: file.type || 'image/jpeg' }),
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const code = (json.code as IsbnScanErrorCode) ?? 'UNKNOWN';
    throw new IsbnScanError(code, (json.error as string) ?? `isbn-scan ${resp.status}`);
  }
  const isbn = typeof json.isbn === 'string' ? json.isbn : null;
  return isbn ? (normalizeIsbn(isbn) ?? isbn) : null;
}
