import type { Cookbook } from '@cookyourbooks/domain';
import type { BookMetadataMatch } from './bookLookup.js';

// NOTE: keep this module free of any import that transitively pulls
// `../supabase.js` (which throws at load when VITE_SUPABASE_* are unset).
// That keeps the pure form logic unit-testable in CI without env vars; the
// cover-uploading builder lives in `buildCookbook.ts`.

// Shared editable state for "a cookbook's metadata", used by every add/edit
// entry point (New Collection, the inline create in the import wizards, and
// the collection page's Edit details dialog). Kept as plain strings so it
// binds straight to inputs; `buildCookbookFromForm` does the coercion +
// cover upload at save time.

export interface BookForm {
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publicationYear: string;
  /** A cover already in the `covers` bucket (catalog hit / existing cover). */
  coverImagePath?: string;
  /** Cover bytes staged for upload (Open Library lookup). */
  coverBlob?: Blob | null;
  /** Displayable preview URL for a staged Open Library cover. */
  coverPreviewUrl?: string;
  /** Curated ToC entries available to seed as placeholder recipes. */
  tocEntries?: { title: string; page_number: number | null }[];
}

export function emptyBookForm(): BookForm {
  return { title: '', author: '', isbn: '', publisher: '', publicationYear: '' };
}

export function bookFormFromCookbook(c: Cookbook): BookForm {
  return {
    title: c.title,
    author: c.author ?? '',
    isbn: c.isbn ?? '',
    publisher: c.publisher ?? '',
    publicationYear: c.publicationYear ? String(c.publicationYear) : '',
    coverImagePath: c.coverImagePath,
  };
}

/**
 * Merge a lookup result into a form, only filling fields the user hasn't
 * already typed (so an autofill never clobbers manual edits). Stages the
 * cover for upload (Open Library) or references an existing bucket path
 * (catalog), and carries any ToC entries through for optional seeding.
 */
export function applyMatch(form: BookForm, match: BookMetadataMatch): BookForm {
  return {
    ...form,
    title: form.title.trim() ? form.title : (match.title ?? form.title),
    author: form.author.trim() ? form.author : (match.author ?? form.author),
    publisher: form.publisher.trim() ? form.publisher : (match.publisher ?? form.publisher),
    publicationYear:
      form.publicationYear.trim() || !match.publicationYear
        ? form.publicationYear
        : String(match.publicationYear),
    // Only adopt the looked-up cover if the user hasn't already got one.
    coverImagePath: form.coverImagePath ?? match.coverImagePath,
    coverBlob: form.coverImagePath ? form.coverBlob : (match.coverBlob ?? form.coverBlob),
    coverPreviewUrl: form.coverImagePath ? form.coverPreviewUrl : (match.coverUrl ?? form.coverPreviewUrl),
    tocEntries: match.tocEntries ?? form.tocEntries,
  };
}
