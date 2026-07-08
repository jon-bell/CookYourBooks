import { describe, expect, it } from 'vitest';

import { buildImportItemInsertPayload, parseJsonStringArray } from './importItemPayload.js';

/** A minimal local `import_items` row as `db.execO` returns it (all values
 *  loosely typed). Overridable per-test. */
function localRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    batch_id: 'batch-1',
    owner_id: 'owner-1',
    page_index: 0,
    storage_path: 'owner-1/batch-1/pages/item-1.jpg',
    thumb_path: 'owner-1/batch-1/thumbs/item-1.jpg',
    source_pdf_path: null,
    source_pdf_page: null,
    assigned_collection_id: null,
    assigned_page_number: null,
    assigned_recipe_id: null,
    is_toc: 0,
    kind: 'RECIPE',
    status: 'PENDING',
    extra_storage_paths: '[]',
    ...overrides,
  };
}

describe('parseJsonStringArray', () => {
  it('parses a JSON string array', () => {
    expect(parseJsonStringArray('["a","b"]')).toEqual(['a', 'b']);
  });

  it('returns [] for empty / null / non-string', () => {
    expect(parseJsonStringArray('[]')).toEqual([]);
    expect(parseJsonStringArray('')).toEqual([]);
    expect(parseJsonStringArray(null)).toEqual([]);
    expect(parseJsonStringArray(undefined)).toEqual([]);
    expect(parseJsonStringArray(42)).toEqual([]);
  });

  it('returns [] for malformed JSON without throwing', () => {
    expect(parseJsonStringArray('not json')).toEqual([]);
    expect(parseJsonStringArray('{')).toEqual([]);
  });

  it('drops non-string members', () => {
    expect(parseJsonStringArray('["a",1,null,"b"]')).toEqual(['a', 'b']);
  });

  it('returns [] for a JSON value that is not an array', () => {
    expect(parseJsonStringArray('"a"')).toEqual([]);
    expect(parseJsonStringArray('{"0":"a"}')).toEqual([]);
  });
});

describe('buildImportItemInsertPayload', () => {
  it('round-trips extra_storage_paths (the regression this guards)', () => {
    const extras = ['owner-1/batch-1/pages/x.jpg', 'owner-1/batch-1/pages/y.jpg'];
    const payload = buildImportItemInsertPayload(
      localRow({ extra_storage_paths: JSON.stringify(extras) }),
    );
    expect(payload.extra_storage_paths).toEqual(extras);
  });

  it('defaults extra_storage_paths to [] when the local column is empty/null/malformed', () => {
    expect(
      buildImportItemInsertPayload(localRow({ extra_storage_paths: '[]' })).extra_storage_paths,
    ).toEqual([]);
    expect(
      buildImportItemInsertPayload(localRow({ extra_storage_paths: null })).extra_storage_paths,
    ).toEqual([]);
    expect(
      buildImportItemInsertPayload(localRow({ extra_storage_paths: 'oops' })).extra_storage_paths,
    ).toEqual([]);
  });

  it('coerces is_toc from the SQLite integer/boolean to a boolean', () => {
    expect(buildImportItemInsertPayload(localRow({ is_toc: 1 })).is_toc).toBe(true);
    expect(buildImportItemInsertPayload(localRow({ is_toc: 0 })).is_toc).toBe(false);
    expect(buildImportItemInsertPayload(localRow({ is_toc: true })).is_toc).toBe(true);
  });

  it('defaults kind to RECIPE and passes status through', () => {
    expect(buildImportItemInsertPayload(localRow({ kind: null })).kind).toBe('RECIPE');
    expect(buildImportItemInsertPayload(localRow({ kind: 'TOC' })).kind).toBe('TOC');
    expect(buildImportItemInsertPayload(localRow({ status: 'AWAITING_GROUPING' })).status).toBe(
      'AWAITING_GROUPING',
    );
  });

  it('preserves nullable path/assignment fields', () => {
    const payload = buildImportItemInsertPayload(
      localRow({
        thumb_path: null,
        assigned_recipe_id: 'recipe-9',
        assigned_page_number: 12,
        source_pdf_page: 3,
      }),
    );
    expect(payload.thumb_path).toBeNull();
    expect(payload.assigned_recipe_id).toBe('recipe-9');
    expect(payload.assigned_page_number).toBe(12);
    expect(payload.source_pdf_page).toBe(3);
  });
});
