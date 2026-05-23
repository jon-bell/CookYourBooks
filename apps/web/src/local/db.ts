import initWasm, { DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { CRR_TABLES, POST_SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from './schema.js';

export type LocalDb = DB;

let initPromise: Promise<LocalDb> | undefined;

export function getLocalDb(): Promise<LocalDb> {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

async function initialize(): Promise<LocalDb> {
  const sqlite = await initWasm(() => wasmUrl);
  const db = await sqlite.open('cookyourbooks.db');

  // Apply schema (idempotent) — `CREATE TABLE IF NOT EXISTS`.
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.exec(stmt);
  }

  // Run post-schema migrations BEFORE promoting tables to CRR. Once a
  // table is a CRR, cr-sqlite blocks plain `ALTER TABLE` ("table %s may
  // not be altered") — you have to bracket it with crsql_begin_alter /
  // crsql_commit_alter. On a user's existing browser DB the tables are
  // already CRR from a previous boot, so we use the bracketed form for
  // anything touching a CRR table.
  for (const stmt of POST_SCHEMA_MIGRATIONS) {
    await applyPostSchemaMigration(db, stmt);
  }

  // Promote tables to CRRs. crsql_as_crr is idempotent — safe to re-run.
  for (const table of CRR_TABLES) {
    await db.exec(`select crsql_as_crr('${table}')`);
  }

  return db;
}

const ADD_COLUMN_RE = /^\s*alter\s+table\s+([a-z_][a-z0-9_]*)\s+add\s+column\s+([a-z_][a-z0-9_]*)\b/i;

async function applyPostSchemaMigration(db: LocalDb, stmt: string): Promise<void> {
  const addCol = stmt.match(ADD_COLUMN_RE);
  if (!addCol) {
    // Non-ALTER statement (e.g. `create index if not exists ...`). Run
    // directly; these are already idempotent.
    await db.exec(stmt);
    return;
  }
  const table = addCol[1]!;
  const column = addCol[2]!;
  if (await columnExists(db, table, column)) return;

  const isCrr = CRR_TABLES.includes(table);
  if (isCrr) await db.exec(`select crsql_begin_alter('${table}')`);
  try {
    await db.exec(stmt);
  } catch (err) {
    // Another concurrent boot raced us, or the column landed via a path
    // we don't track. Either way: if the column is now present, the
    // migration is effectively done.
    const msg = String((err as Error).message ?? '');
    if (!/duplicate column name|already exists/i.test(msg)) {
      if (isCrr) await db.exec(`select crsql_commit_alter('${table}')`);
      throw err;
    }
  }
  if (isCrr) await db.exec(`select crsql_commit_alter('${table}')`);
}

async function columnExists(db: LocalDb, table: string, column: string): Promise<boolean> {
  const rows = await db.execA<unknown[]>(`pragma table_info(${table})`);
  // pragma_table_info returns rows shaped [cid, name, type, notnull, dflt, pk].
  return rows.some((row) => row[1] === column);
}

// For tests/dev tools to reset the local database between runs.
export async function resetLocalDb(): Promise<void> {
  if (!initPromise) return;
  const db = await initPromise;
  await db.close();
  initPromise = undefined;
  // We leave the persisted IndexedDB alone — callers that really want a
  // fresh start can clear browser storage manually. Closing the handle is
  // enough for test flows.
}
