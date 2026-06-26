import { decode, encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';

import { type ColumnarTable, decodeColumnar, encodeColumnar } from './snapshotCodec.js';

describe('snapshotCodec', () => {
  it('roundtrips object rows through columnar form', () => {
    const rows = [
      { id: 'a', title: 'One', servings_amount: 4, notes: null },
      { id: 'b', title: 'Two', servings_amount: null, notes: 'hi' },
    ];
    expect(decodeColumnar(encodeColumnar(rows))).toEqual(rows);
  });

  it('handles empty input', () => {
    expect(encodeColumnar([])).toEqual({ cols: [], rows: [] });
    expect(decodeColumnar({ cols: [], rows: [] })).toEqual([]);
    expect(decodeColumnar(undefined)).toEqual([]);
  });

  it('preserves nested JSON (jsonb columns) and types', () => {
    const rows = [{ id: 'x', meta: { a: 1, b: [true, null, 'z'] }, n: 3.5, flag: false }];
    const back = decodeColumnar(encodeColumnar(rows));
    expect(back).toEqual(rows);
  });

  it('survives a MessagePack roundtrip (the wire format)', () => {
    const rows = [
      { id: 'a', updated_at: '2026-06-17T00:00:00+00:00', tags: ['x', 'y'], q: 0 },
      { id: 'b', updated_at: '2026-06-17T00:00:01+00:00', tags: [], q: null },
    ];
    const table = encodeColumnar(rows);
    const bytes = encode(table);
    const wire = decode(bytes) as ColumnarTable;
    expect(decodeColumnar(wire)).toEqual(rows);
  });
});
