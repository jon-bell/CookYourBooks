// Columnar (de)serialization for the library-snapshot Edge Function.
//
// The full-pull snapshot ships rows as `{ cols, rows }` — column names
// once, then an array of value-arrays — instead of an array of objects
// with the keys repeated per row. After MessagePack + gzip this is a
// large win over PostgREST's `select('*')` JSON (which repeats every
// column name on every row). The format is schema-agnostic: the Edge
// Function emits whatever `select('*')` returned and the client zips it
// straight back into PostgREST-shaped row objects, so neither side hard-
// codes a column list and a schema change can't desync them.
//
// The Edge Function (Deno) carries its own byte-identical copy of
// `encodeColumnar` (same copy-verbatim convention as the parser); this
// module is the client decoder + the contract the roundtrip test pins.

export interface ColumnarTable {
  cols: string[];
  rows: unknown[][];
}

export type Row = Record<string, unknown>;

/** Object rows → columnar. Column order is taken from the first row. */
export function encodeColumnar(rows: readonly Row[]): ColumnarTable {
  if (rows.length === 0) return { cols: [], rows: [] };
  const cols = Object.keys(rows[0]!);
  const out: unknown[][] = new Array<unknown[]>(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    const arr = new Array<unknown>(cols.length);
    for (let c = 0; c < cols.length; c += 1) arr[c] = r[cols[c]!];
    out[i] = arr;
  }
  return { cols, rows: out };
}

/** Columnar → object rows (the inverse of {@link encodeColumnar}). */
export function decodeColumnar<T = Row>(table: ColumnarTable | undefined | null): T[] {
  if (!table || table.rows.length === 0) return [];
  const { cols, rows } = table;
  const out: T[] = new Array<T>(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const arr = rows[i]!;
    const obj: Row = {};
    for (let c = 0; c < cols.length; c += 1) obj[cols[c]!] = arr[c];
    out[i] = obj as T;
  }
  return out;
}

// ---- snapshot envelope shapes (shared contract with the Edge Function) ----

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** `stage:'meta'` response — collections + recipe cards (no folded JSON). */
export interface SnapshotMeta {
  schemaVersion: number;
  generatedAt: string;
  collections: ColumnarTable;
  recipes: ColumnarTable;
}

/** `stage:'bodies'` response — each recipe's folded JSON (id + ingredients +
 *  instructions), attached back onto the recipe rows locally by id. */
export interface SnapshotBodies {
  schemaVersion: number;
  recipeBodies: ColumnarTable;
}
