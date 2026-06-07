import {
  createCookbook,
  createRecipe,
  type Cookbook,
  type RecipeCollection,
} from '@cookyourbooks/domain';
import { normalizeIsbn } from './openLibrary.js';
import { uploadCollectionCover } from './cover.js';
import type { BookMetadataMatch } from './bookLookup.js';

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

function parseYear(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Build a Cookbook from form state, uploading any staged cover first (we
 * mint the id up front so the cover path is stable). When `base` is given
 * (the Edit-details flow) its recipes / public / moderation state are
 * preserved; otherwise `seedToc` optionally seeds placeholder recipes from
 * the curated table of contents.
 */
export async function buildCookbookFromForm(
  form: BookForm,
  opts: { userId: string; base?: Cookbook; seedToc?: boolean },
): Promise<RecipeCollection> {
  const id = opts.base?.id ?? crypto.randomUUID();

  let coverImagePath = form.coverImagePath;
  if (form.coverBlob) {
    coverImagePath = await uploadCollectionCover(opts.userId, id, form.coverBlob);
  }

  const recipes = opts.base
    ? opts.base.recipes
    : opts.seedToc && form.tocEntries
      ? form.tocEntries.map((e) =>
          createRecipe({
            title: e.title,
            pageNumbers: typeof e.page_number === 'number' ? [e.page_number] : undefined,
          }),
        )
      : undefined;

  return createCookbook({
    id,
    title: form.title.trim(),
    author: form.author.trim() || undefined,
    isbn: form.isbn.trim() ? (normalizeIsbn(form.isbn) ?? form.isbn.trim()) : undefined,
    publisher: form.publisher.trim() || undefined,
    publicationYear: parseYear(form.publicationYear),
    coverImagePath,
    recipes,
    isPublic: opts.base?.isPublic,
    forkedFrom: opts.base?.forkedFrom,
    moderationState: opts.base?.moderationState,
    moderationReason: opts.base?.moderationReason,
  });
}
