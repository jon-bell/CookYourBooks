import { describe, expect, it } from 'vitest';
import { applyMatch, emptyBookForm } from './bookForm.js';
import type { BookMetadataMatch } from './bookLookup.js';

const catalogMatch: BookMetadataMatch = {
  source: 'catalog',
  title: 'The Food Lab',
  author: 'J. Kenji López-Alt',
  publisher: 'Norton',
  publicationYear: 2015,
  coverImagePath: 'global/abc.jpg',
  tocEntries: [{ title: 'Eggs', page_number: 100 }],
};

const openLibraryMatch: BookMetadataMatch = {
  source: 'openlibrary',
  title: 'Salt Fat Acid Heat',
  author: 'Samin Nosrat',
  coverUrl: 'https://covers.openlibrary.org/x-L.jpg',
  coverBlob: new Blob(['img'], { type: 'image/jpeg' }),
};

describe('applyMatch', () => {
  it('fills empty fields from a catalog match and carries the cover + ToC', () => {
    const next = applyMatch(emptyBookForm(), catalogMatch);
    expect(next.title).toBe('The Food Lab');
    expect(next.author).toBe('J. Kenji López-Alt');
    expect(next.publisher).toBe('Norton');
    expect(next.publicationYear).toBe('2015');
    expect(next.coverImagePath).toBe('global/abc.jpg');
    expect(next.tocEntries).toHaveLength(1);
  });

  it('does not clobber fields the user already typed', () => {
    const form = { ...emptyBookForm(), title: 'My title', author: 'My author' };
    const next = applyMatch(form, catalogMatch);
    expect(next.title).toBe('My title');
    expect(next.author).toBe('My author');
    // Still backfills the fields the user left blank.
    expect(next.publisher).toBe('Norton');
  });

  it('stages an Open Library cover blob + preview URL (no bucket path yet)', () => {
    const next = applyMatch(emptyBookForm(), openLibraryMatch);
    expect(next.coverImagePath).toBeUndefined();
    expect(next.coverPreviewUrl).toBe('https://covers.openlibrary.org/x-L.jpg');
    expect(next.coverBlob).toBeInstanceOf(Blob);
  });

  it('keeps an existing cover instead of adopting the looked-up one', () => {
    const form = { ...emptyBookForm(), coverImagePath: 'me/collections/x.jpg' };
    const next = applyMatch(form, openLibraryMatch);
    expect(next.coverImagePath).toBe('me/collections/x.jpg');
    expect(next.coverBlob).toBeUndefined();
    expect(next.coverPreviewUrl).toBeUndefined();
  });
});
