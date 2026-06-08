/**
 * A general note attached to a recipe collection — prose about a cookbook's
 * content (forewords, chapter introductions, technique essays, headnotes)
 * captured by the OCR import, or written by hand. Distinct from a recipe: it
 * has no ingredients or steps, just a title and a Markdown body.
 *
 * A note belongs to one user (owner) and, once filed, one collection. Notes
 * sync and share with the household exactly like the rest of the library.
 */
export interface CollectionNote {
  readonly id: string;
  /** The collection this note is filed under, or null while unfiled (e.g. a
   *  note OCR'd from an unassigned scan batch, pending the user filing it). */
  readonly collectionId: string | null;
  readonly title: string;
  /** Prose body, stored as Markdown. */
  readonly body: string;
  /** Source cookbook page number(s), when known. */
  readonly pageNumbers?: readonly number[];
  /** Raw OCR text the note was extracted from (debug / re-extraction). */
  readonly sourceImageText?: string;
  /** Ordering within a collection. */
  readonly sortOrder: number;
}

export function newCollectionNoteId(): string {
  return crypto.randomUUID();
}

export function createCollectionNote(params: {
  id?: string;
  collectionId: string | null;
  title?: string;
  body: string;
  pageNumbers?: readonly number[];
  sourceImageText?: string;
  sortOrder?: number;
}): CollectionNote {
  return {
    id: params.id ?? newCollectionNoteId(),
    collectionId: params.collectionId,
    title: params.title?.trim() || 'Note',
    body: params.body,
    pageNumbers: params.pageNumbers ? [...params.pageNumbers] : undefined,
    sourceImageText: params.sourceImageText,
    sortOrder: params.sortOrder ?? 0,
  };
}
