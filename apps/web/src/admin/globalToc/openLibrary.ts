// Moved to apps/web/src/books/openLibrary.ts so non-admin flows (the New
// Collection page, the unified book form) can use it too. Re-exported here
// to keep the admin global-TOC imports working unchanged.
export {
  normalizeIsbn,
  lookupOpenLibrary,
  type OpenLibraryMetadata,
  type OpenLibraryLookup,
} from '../../books/openLibrary.js';
