import initWasm, { DB } from '@vlcn.io/crsqlite-wasm';
import wasmUrl from '@vlcn.io/crsqlite-wasm/crsqlite.wasm?url';
import { CRR_TABLES, POST_SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from './schema.js';
import { logSync } from './syncLog.js';

export type LocalDb = DB;

let initPromise: Promise<LocalDb> | undefined;

// The raw cr-sqlite handle (before the lock wrapper), captured as soon as
// it's opened so the emergency reset can force-close it even when init
// later throws. A leaked-open handle keeps the `idb-batch-atomic`
// IndexedDB open, which makes `deleteDatabase` fire `onblocked` and hang —
// that's the "delete blocked — close other tabs" wedge (there are no other
// tabs on Capacitor; the blocker is this page's own connection).
let rawHandle: DB | null = null;

// localStorage flag: an emergency reset that couldn't delete the IndexedDB
// in-page (still blocked despite closing our handle) sets this and reloads.
// On the next boot we delete BEFORE opening the DB — nothing holds it open
// at that point, so the delete can't be blocked. This guarantees recovery.
const PENDING_RESET_KEY = 'cookyourbooks.db.pendingReset';

// The IndexedDB database backing the cr-sqlite VFS (see
// @vlcn.io/crsqlite-wasm: `new IDBBatchAtomicVFS("idb-batch-atomic", …)`).
const VFS_IDB_NAME = 'idb-batch-atomic';

// Delete the VFS IndexedDB, resolving on success/error/blocked alike and on
// a hard timeout so a stuck request can never hang the caller (the old
// `onblocked`-only-logs path is exactly what wedged the reset button).
function deleteVfsIdb(): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const req = indexedDB.deleteDatabase(VFS_IDB_NAME);
      req.onsuccess = done;
      req.onerror = done;
      req.onblocked = () => {
        logSync('warn', 'deleteVfsIdb: blocked — armed for pre-init delete on next boot');
        done();
      };
    } catch {
      done();
    }
    setTimeout(done, 3_000);
  });
}

// If a prior emergency reset armed a pending delete, run it now — before
// anything opens the VFS — so it completes cleanly without being blocked.
async function drainPendingReset(): Promise<void> {
  let pending = false;
  try {
    pending = localStorage.getItem(PENDING_RESET_KEY) === '1';
  } catch {
    // no localStorage (private mode / SSR) — nothing to drain
  }
  if (!pending) return;
  logSync('warn', 'db init: draining pending emergency reset (deleting VFS idb before open)');
  await deleteVfsIdb();
  try {
    localStorage.removeItem(PENDING_RESET_KEY);
  } catch {
    // ignore
  }
}

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
  // Swallow `prev`'s rejection on the tail too — otherwise one thrown
  // op turns `dbLockTail` into a rejected promise, and every future
  // `await prev` throws before reaching release(), permanently wedging
  // the queue.
  dbLockTail = prev.then(() => held, () => held);
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
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // `.catch(() => {})` so a failure in the previous op doesn't abort
    // *this* op before we reach release() — we only care about taking
    // our turn, not whether the predecessor succeeded.
    await prev.catch(() => {});
    clearTimeout(waitTimer);
    op.state = 'running';
    op.startedAt = Date.now();
    runTimer = setTimeout(() => {
      if (op.state === 'running') {
        logSync('warn', `db op slow: ${label} still running after ${Date.now() - op.startedAt}ms`, {
          opId: op.id,
        });
      }
    }, SLOW_LOCK_WARN_MS);
    return await fn();
  } finally {
    clearTimeout(waitTimer);
    if (runTimer) clearTimeout(runTimer);
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

interface DbInitState {
  startedAt: number | null;
  finishedAt: number | null;
  step: string;
  error: string | null;
}
const initState: DbInitState = {
  startedAt: null,
  finishedAt: null,
  step: 'not started',
  error: null,
};

export function snapshotDbInit(): Readonly<DbInitState> {
  return { ...initState };
}

function setInitStep(step: string): void {
  initState.step = step;
  logSync('info', `db init: ${step}`);
}

export function getLocalDb(): Promise<LocalDb> {
  if (!initPromise) {
    initState.startedAt = Date.now();
    initState.step = 'starting';
    logSync('info', 'db init: starting (this should appear once per page load)');
    initPromise = initialize()
      .then((db) => {
        initState.finishedAt = Date.now();
        initState.step = 'ready';
        logSync(
          'info',
          `db init: ready in ${initState.finishedAt - (initState.startedAt ?? 0)}ms`,
        );
        return db;
      })
      .catch((err) => {
        const msg = (err as Error).message;
        initState.error = msg;
        initState.step = `failed (${msg})`;
        logSync('error', `db init: FAILED — ${msg}`);
        throw err;
      });
  }
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
// v2 (2026-06-18): cooking_events gained photo_paths.
// v3 (2026-06-20): cooking_events gained meal_slot.
// Re-emit CRR triggers so DBs that promoted the table before a column
// exists pick up the widened shape (otherwise INSERTs hit "expected N
// values, got M").
const CRR_TRIGGER_HEAL_VERSION = 3;

// Only the tables whose CRR shape actually changed across the heal versions
// above. Every heal-versioned change has been on cooking_events, so that's
// all we cycle. Healing *every* CRR table forced cr-sqlite's
// O(table-size) commit_alter compaction over the 16k-row `recipes` table,
// which could fail with "failed compacting tables post alteration" and
// wedge db init (CYB-CAPACITOR-8). recipes/ingredients/instructions/refs
// columns are added through the begin/commit_alter-bracketed
// applyPostSchemaMigration path, so their triggers are already current.
const CRR_TRIGGER_HEAL_TABLES = ['cooking_events'];

async function initialize(): Promise<LocalDb> {
  await drainPendingReset();
  setInitStep('init wasm');
  const sqlite = await initWasm(() => wasmUrl);
  setInitStep('opening cookyourbooks.db');
  const db = await sqlite.open('cookyourbooks.db');
  rawHandle = db;

  try {
    setInitStep('applying schema');
    for (const stmt of SCHEMA_STATEMENTS) {
      await db.exec(stmt);
    }

    setInitStep('post-schema migrations');
    for (const stmt of POST_SCHEMA_MIGRATIONS) {
      await applyPostSchemaMigration(db, stmt);
    }

    setInitStep('promoting tables to CRR');
    for (const table of CRR_TABLES) {
      await db.exec(`select crsql_as_crr('${table}')`);
    }

    setInitStep('CRR trigger heal');
    await maybeHealCrrTriggers(db);

    setInitStep('done (wrapping in lock)');
    return lockDb(db);
  } catch (err) {
    // Don't leak the open handle: a wedged init would otherwise hold the
    // VFS IndexedDB open and block the emergency reset's delete forever.
    try {
      await db.close();
    } catch {
      // already broken — best effort
    }
    rawHandle = null;
    throw err;
  }
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

  for (const table of CRR_TRIGGER_HEAL_TABLES) {
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

/**
 * Emergency reset: nuke the persisted SQLite (the IndexedDB the
 * cr-sqlite VFS sits on top of) and reload. Used from the sync
 * diagnostics dialog when init wedges. Doesn't touch Supabase — the
 * next pull rehydrates from the server.
 */
export async function emergencyResetLocalDb(): Promise<void> {
  logSync('warn', 'emergencyResetLocalDb: deleting idb-batch-atomic');
  // Arm the pre-init delete first. Even if the in-page delete below stays
  // blocked (a connection we can't reach is still open), the next boot
  // deletes the VFS idb before anything opens it — so recovery is
  // guaranteed across the reload regardless of what's holding it now.
  try {
    localStorage.setItem(PENDING_RESET_KEY, '1');
  } catch {
    // ignore
  }
  try {
    // Force-close every handle we know about so the delete isn't blocked:
    // the lock-wrapped db from a resolved init, and the raw handle captured
    // during an init that may have thrown mid-way.
    if (initPromise) {
      try {
        const db = await Promise.race([
          initPromise,
          new Promise<null>((r) => setTimeout(() => r(null), 1000)),
        ]);
        if (db) await db.close();
      } catch {
        // Init is wedged — proceed to delete anyway.
      }
      initPromise = undefined;
    }
    if (rawHandle) {
      try {
        await rawHandle.close();
      } catch {
        // already broken — best effort
      }
      rawHandle = null;
    }
    await deleteVfsIdb();
    logSync('info', 'emergencyResetLocalDb: deleted (or armed for next boot); reloading');
  } finally {
    location.reload();
  }
}
