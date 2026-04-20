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

  // SQLite's `ALTER TABLE ADD COLUMN` doesn't accept `IF NOT EXISTS`, so
  // we run each post-schema migration and swallow "duplicate column"
  // errors. That keeps upgrades idempotent for users whose IndexedDB
  // already has the old shape.
  for (const stmt of POST_SCHEMA_MIGRATIONS) {
    try {
      await db.exec(stmt);
    } catch (err) {
      const msg = String((err as Error).message ?? '');
      if (!/duplicate column name|already exists/i.test(msg)) throw err;
    }
  }

  // Promote tables to CRRs. crsql_as_crr is idempotent — safe to re-run.
  for (const table of CRR_TABLES) {
    await db.exec(`select crsql_as_crr('${table}')`);
  }

  return db;
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
