import initWasm, { DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { CRR_TABLES, POST_SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from './schema.js';
import { logSync } from './syncLog.js';

export type LocalDb = DB;

let initPromise: Promise<LocalDb> | undefined;

/** Serializes WASM SQLite access — concurrent exec from sync + import deadlocks. */
let dbLockTail: Promise<void> = Promise.resolve();

interface DbLockOp {
  id: number;
  label: string;
  startedAt: number;
  state: 'waiting' | 'running';
}
let dbOpSeq = 1;
const liveOps = new Map<number, DbLockOp>();
const SLOW_LOCK_WARN_MS = 3_000;

export function snapshotDbOps(): DbLockOp[] {
  return [...liveOps.values()].sort((a, b) => a.id - b.id);
}

async function withDbLock<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = dbLockTail;
  dbLockTail = prev.then(() => held);
  const op: DbLockOp = {
    id: dbOpSeq++,
    label,
    startedAt: Date.now(),
    state: 'waiting',
  };
  liveOps.set(op.id, op);
  // If we're not first in line, warn after a few seconds — likeliest
  // cause of a stuck cycle is an earlier op that never resolved.
  const waitTimer = setTimeout(() => {
    if (op.state === 'waiting') {
      logSync('warn', `db lock: still waiting after ${Date.now() - op.startedAt}ms`, {
        label,
        opId: op.id,
        liveOps: [...liveOps.values()].map((o) => ({
          id: o.id,
          label: o.label,
          state: o.state,
          ageMs: Date.now() - o.startedAt,
        })),
      });
    }
  }, SLOW_LOCK_WARN_MS);
  try {
    await prev;
  } finally {
    clearTimeout(waitTimer);
  }
  op.state = 'running';
  op.startedAt = Date.now();
  const runTimer = setTimeout(() => {
    if (op.state === 'running') {
      logSync('warn', `db op slow: ${label} still running after ${Date.now() - op.startedAt}ms`, {
        opId: op.id,
      });
    }
  }, SLOW_LOCK_WARN_MS);
  try {
    return await fn();
  } finally {
    clearTimeout(runTimer);
    liveOps.delete(op.id);
    release();
  }
}

function lockDb(db: DB): LocalDb {
  return {
    exec: (sql, bind) => withDbLock(() => db.exec(sql, bind), labelFor(sql)),
    execO: (sql, bind) => withDbLock(() => db.execO(sql, bind), labelFor(sql)),
    execA: (sql, bind) => withDbLock(() => db.execA(sql, bind), labelFor(sql)),
    // Hold the mutex for the whole transaction — tx.exec runs on the raw handle.
    tx: (fn) => withDbLock(() => db.tx(fn), 'tx'),
    close: () => db.close(),
  } as LocalDb;
}

function labelFor(sql: string): string {
  const trimmed = sql.trim().replace(/\s+/g, ' ');
  return trimmed.slice(0, 80);
}

export function getLocalDb(): Promise<LocalDb> {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

// Bump when the CRR trigger shape has drifted from what older builds
// promoted. Each boot at a higher version runs a one-time
// `crsql_begin_alter` / `crsql_commit_alter` cycle on every CRR table
// to force cr-sqlite to re-emit per-column triggers against the
// current schema. Without this, users whose DBs were upgraded by
// earlier builds (before we bracketed ALTERs with begin/commit_alter)
// keep stale triggers and INSERTs blow up with "expected N values,
// got M".
const CRR_TRIGGER_HEAL_VERSION = 1;

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

  // One-time heal for users whose previous boots added columns without
  // bracketing the ALTER. Those triggers describe an older column list
  // and any subsequent INSERT fails. Forcing a begin/commit_alter
  // cycle on each CRR table rebuilds the triggers against the current
  // schema. Gated on a stored marker so we don't churn metadata on
  // every load once a given user has been healed.
  await maybeHealCrrTriggers(db);

  return lockDb(db);
}

async function maybeHealCrrTriggers(db: LocalDb): Promise<void> {
  // `crsql_master` is cr-sqlite's own key/value store and exists for
  // every initialised DB; piggy-backing on it avoids us provisioning
  // a custom marker table just for this.
  const rows = await db.execA<[string | number]>(
    `select value from crsql_master where key = 'cyb_crr_trigger_heal'`,
  );
  const stored = Number(rows[0]?.[0] ?? 0);
  if (stored >= CRR_TRIGGER_HEAL_VERSION) return;

  for (const table of CRR_TABLES) {
    try {
      await db.exec(`select crsql_begin_alter('${table}')`);
    } catch {
      // Not a CRR (shouldn't happen — we just promoted above). Skip.
      continue;
    }
    // The no-op alter cycle is enough — commit re-emits triggers. If
    // commit itself throws, the table is left mid-alter; surface so we
    // hear about it rather than silently leaving the DB wedged.
    await db.exec(`select crsql_commit_alter('${table}')`);
  }

  await db.exec(
    `insert or replace into crsql_master (key, value) values (?, ?)`,
    ['cyb_crr_trigger_heal', CRR_TRIGGER_HEAL_VERSION],
  );
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
