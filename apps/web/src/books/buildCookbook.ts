import {
  type Cookbook,
  createCookbook,
  createRecipe,
  type RecipeCollection,
} from '@cookyourbooks/domain';

import type { BookForm } from './bookForm.js';
import { uploadCollectionCover } from './cover.js';
import { normalizeIsbn } from './openLibrary.js';

// Cover-uploading builder, split from bookForm.ts so the pure form logic
// stays import-safe (this module pulls supabase via cover.ts).

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
