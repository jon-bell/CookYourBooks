import { useQuery } from '@tanstack/react-query';

import { findCookbookByIsbn } from '../data/globalCookbookLookup.js';
import { lookupOpenLibrary, normalizeIsbn } from './openLibrary.js';

// Unified book-metadata lookup: try our curated `global_cookbooks` catalog
// first (a single indexed read, and it carries a cover already in the
// `covers` bucket plus a known table of contents), and fall back to Open
// Library for anything not yet curated. Used by the shared book form so any
// "add a cookbook" entry point gets the same enrichment.

export interface BookMetadataMatch {
  source: 'catalog' | 'openlibrary';
  title?: string;
  author?: string;
  publisher?: string;
  publicationYear?: number;
  /** A cover already living in the `covers` bucket (catalog hits only). */
  coverImagePath?: string;
  /** Displayable cover URL for a preview (Open Library hits). */
  coverUrl?: string;
  /** Cover bytes to upload onto the user's own collection (Open Library). */
  coverBlob?: Blob | null;
  /** Curated table-of-contents entries, for optional placeholder seeding. */
  tocEntries?: { title: string; page_number: number | null }[];
}

async function lookupBookMetadata(isbn: string): Promise<BookMetadataMatch | null> {
  const catalog = await findCookbookByIsbn(isbn);
  if (catalog) {
    return {
      source: 'catalog',
      title: catalog.title,
      author: catalog.author ?? undefined,
      publisher: catalog.publisher ?? undefined,
      publicationYear: catalog.publication_year ?? undefined,
      coverImagePath: catalog.cover_image_path ?? undefined,
      tocEntries: catalog.entries.map((e) => ({ title: e.title, page_number: e.page_number })),
    };
  }
  const { metadata, cover } = await lookupOpenLibrary(isbn);
  if (!metadata && !cover) return null;
  return {
    source: 'openlibrary',
    title: metadata?.title,
    author: metadata?.author,
    publisher: metadata?.publisher,
    publicationYear: metadata?.publicationYear,
    coverUrl: metadata?.coverUrl,
    coverBlob: cover,
  };
}

export interface BookLookupState {
  match: BookMetadataMatch | null;
  isLoading: boolean;
  /** The normalized ISBN we actually queried, or null if input wasn't one. */
  triedIsbn: string | null;
}

/**
 * Looks up book metadata for `rawIsbn`, only firing once the input
 * normalizes to a plausible ISBN (so we don't hit the network on every
 * keystroke). Catalog-then-OpenLibrary; returns a tristate the form can
 * render (loading / found / not-found).
 */
export function useBookMetadataLookup(rawIsbn: string): BookLookupState {
  const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : null;
  const { data, isLoading } = useQuery({
    queryKey: ['book-metadata-by-isbn', isbn],
    enabled: !!isbn,
    staleTime: 60_000,
    queryFn: () => lookupBookMetadata(isbn!),
  });
  return { match: data ?? null, isLoading, triedIsbn: isbn };
}
