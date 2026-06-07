// Open Library lookup by ISBN. Used to enrich a user's cookbook with
// title / author / publisher / year and a cover image, and (under
// admin/globalToc) to seed the curated global catalog.
//
// We hit two endpoints by ISBN:
//   1. https://openlibrary.org/api/books?bibkeys=ISBN:<isbn>&format=json&jscmd=data
//      → title, authors, publishers, publish_date, cover URLs.
//   2. https://covers.openlibrary.org/b/isbn/<isbn>-L.jpg
//      → the cover image, fetched as a Blob so we can upload it into the
//      `covers` storage bucket.
//
// Both are CORS-friendly from the browser. Failures are non-fatal — the
// caller can fall back to manual entry.

export interface OpenLibraryMetadata {
  title?: string;
  author?: string;
  publisher?: string;
  publicationYear?: number;
  coverUrl?: string;
}

export interface OpenLibraryLookup {
  metadata: OpenLibraryMetadata | null;
  cover: Blob | null;
}

// ISBN normalization: strip dashes, spaces, and lowercase X is not used in
// our keying (we uppercase the trailing X for ISBN-10). Returns null if
// the result is not a plausible ISBN length.
export function normalizeIsbn(input: string): string | null {
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  if (!/^\d{9}[\dX]$|^\d{13}$/.test(cleaned)) return null;
  return cleaned;
}

export async function lookupOpenLibrary(rawIsbn: string): Promise<OpenLibraryLookup> {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) throw new Error('Not a valid ISBN-10 or ISBN-13.');

  const [metadata, cover] = await Promise.all([
    fetchMetadata(isbn),
    fetchCover(isbn),
  ]);
  return { metadata, cover };
}

async function fetchMetadata(isbn: string): Promise<OpenLibraryMetadata | null> {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // Network errors shouldn't kill the cover fetch.
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, OpenLibraryBookResponse | undefined>;
  const entry = body[`ISBN:${isbn}`];
  if (!entry) return null;
  return {
    title: entry.title,
    author: entry.authors?.map((a) => a.name).filter(Boolean).join(', ') || undefined,
    publisher: entry.publishers?.map((p) => p.name).filter(Boolean).join(', ') || undefined,
    publicationYear: parsePublicationYear(entry.publish_date),
    coverUrl: entry.cover?.large ?? entry.cover?.medium ?? entry.cover?.small,
  };
}

async function fetchCover(isbn: string): Promise<Blob | null> {
  // `?default=false` makes OL return 404 instead of a 1x1 placeholder
  // when no cover exists for that ISBN — saves us uploading garbage.
  const url = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const blob = await res.blob();
  if (blob.size < 256) return null; // OL sometimes returns a tiny error image.
  return blob;
}

function parsePublicationYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\b(1[5-9]\d{2}|2\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

interface OpenLibraryBookResponse {
  title?: string;
  authors?: Array<{ name?: string }>;
  publishers?: Array<{ name?: string }>;
  publish_date?: string;
  cover?: { small?: string; medium?: string; large?: string };
}
