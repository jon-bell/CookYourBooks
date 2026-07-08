// Background backfill / migration runner for the local SQLite DB.
//
// Some schema evolutions need a one-time pass over existing on-device rows
// (e.g. populating a newly-added derived column). Running that synchronously
// during DB init — on the single cr-sqlite WASM connection — blocks first
// render and starves sync, which is exactly the wedge this whole effort is
// fixing. So heavy backfills run HERE instead: after the first sync settles,
// leader-tab only, in small chunks through the normal lock (so they queue
// fairly with sync), pausing while a sync cycle is in flight, and persisting a
// resumable cursor in `backfill_state` so a reload picks up where it left off.
//
// Progress is observable (subscribeBackfill) for the SchemaUpgradeOverlay.

import { legacyChildRowsToStored, storedIngredientsSearchText } from '@cookyourbooks/db';

import { getLocalDb } from './db.js';
import { computeAndApplyLinks } from './ingredientLinks.js';
import { enqueue } from './outbox.js';
import { logSync } from './syncLog.js';

const CHUNK = 200;
const CHUNK_GAP_MS = 40; // be a good citizen on the shared connection
const PAUSE_POLL_MS = 500;

export interface BackfillProgress {
  id: string;
  status: 'pending' | 'running' | 'done';
  processed: number;
  total: number | null;
}

interface BackfillDef {
  id: string;
  /** Total rows to scan, for the progress bar (best-effort). */
  total(): Promise<number>;
  /**
   * Process one chunk starting after `cursor`. Returns the new cursor, how many
   * rows were scanned, and whether the backfill is complete. Must be idempotent.
   */
  step(
    cursor: string,
    chunkSize: number,
  ): Promise<{ nextCursor: string; scanned: number; done: boolean }>;
}

// ---------- progress pub/sub ----------

const progress = new Map<string, BackfillProgress>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

export function subscribeBackfill(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Snapshot of all known backfills. The overlay shows any that are `running`. */
export function getBackfillProgress(): BackfillProgress[] {
  return [...progress.values()];
}

/** True while any registered backfill is still working. */
export function backfillActive(): boolean {
  return [...progress.values()].some((p) => p.status === 'running');
}

// ---------- backfill_state persistence ----------

async function readState(
  id: string,
): Promise<{ status: string; cursor: string; processed: number } | null> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ status: string; cursor: string; processed: number }>(
    `select status, cursor, processed from backfill_state where id = ?`,
    [id],
  )) as { status: string; cursor: string; processed: number }[];
  return rows[0] ?? null;
}

async function writeState(
  id: string,
  status: string,
  cursor: string,
  processed: number,
): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into backfill_state (id, status, cursor, processed, updated_at)
       values (?,?,?,?,?)
     on conflict(id) do update set
       status = excluded.status,
       cursor = excluded.cursor,
       processed = excluded.processed,
       updated_at = excluded.updated_at`,
    [id, status, cursor, processed, Date.now()],
  );
}

// ---------- the registry ----------

const REGISTRY: BackfillDef[] = [
  {
    // Populate has_content for rows synced before the column existed. New pulls
    // already carry the server value; this only fixes the pre-existing local
    // rows (all defaulted to 0). Monotonic 0->1, so it's safe to re-run.
    id: 'has_content_v1',
    async total() {
      const db = await getLocalDb();
      const rows = (await db.execO<{ c: number }>(
        `select count(*) as c from recipes where deleted = 0`,
      )) as { c: number }[];
      return rows[0]?.c ?? 0;
    },
    async step(cursor, chunkSize) {
      const db = await getLocalDb();
      const ids = (await db.execO<{ id: string }>(
        `select id from recipes where deleted = 0 and id > ? order by id limit ?`,
        [cursor, chunkSize],
      )) as { id: string }[];
      if (ids.length === 0) return { nextCursor: cursor, scanned: 0, done: true };
      const ph = ids.map(() => '?').join(',');
      const args = ids.map((r) => r.id);
      await db.exec(
        `update recipes set has_content = 1
          where id in (${ph})
            and has_content = 0
            and (exists (select 1 from ingredients where recipe_id = recipes.id)
                 or exists (select 1 from instructions where recipe_id = recipes.id))`,
        args,
      );
      return {
        nextCursor: ids[ids.length - 1]!.id,
        scanned: ids.length,
        done: ids.length < chunkSize,
      };
    },
  },
  {
    // Fold pre-2026-07-08 local child rows (ingredients / instructions /
    // instruction_ingredient_refs) into the recipes.ingredients /
    // recipes.instructions JSON columns. New pulls already carry the server
    // JSON; this only fixes rows synced before the fold (ingredients IS NULL).
    // On a fresh install the child tables exist but are empty and every recipe
    // arrives with its JSON already set, so total() is 0 and it no-ops.
    // Runs BEFORE ingredient_links_v1 so the link pass sees the folded JSON.
    id: 'recipe_jsonb_v1',
    async total() {
      const db = await getLocalDb();
      const hasChildren = (await db.execO<{ c: number }>(
        `select count(*) as c from sqlite_master where type = 'table' and name = 'ingredients'`,
      )) as { c: number }[];
      if ((hasChildren[0]?.c ?? 0) === 0) return 0;
      const rows = (await db.execO<{ c: number }>(
        `select count(*) as c from recipes where deleted = 0 and ingredients is null`,
      )) as { c: number }[];
      return rows[0]?.c ?? 0;
    },
    async step(cursor, chunkSize) {
      const db = await getLocalDb();
      const ids = (await db.execO<{ id: string }>(
        `select id from recipes
          where deleted = 0 and ingredients is null and id > ?
          order by id limit ?`,
        [cursor, chunkSize],
      )) as { id: string }[];
      if (ids.length === 0) return { nextCursor: cursor, scanned: 0, done: true };
      for (const { id } of ids) {
        const [ings, insts, refs] = await Promise.all([
          db.execO<Record<string, unknown>>(`select * from ingredients where recipe_id = ?`, [id]),
          db.execO<Record<string, unknown>>(`select * from instructions where recipe_id = ?`, [id]),
          db.execO<Record<string, unknown>>(
            `select r.* from instruction_ingredient_refs r
               join instructions i on i.id = r.instruction_id
              where i.recipe_id = ?`,
            [id],
          ),
        ]);
        const { ingredients, instructions } = legacyChildRowsToStored(ings, insts, refs);
        await db.exec(
          `update recipes
              set ingredients = ?, instructions = ?, ingredients_text = ?, has_content = ?
            where id = ? and ingredients is null`,
          [
            JSON.stringify(ingredients),
            JSON.stringify(instructions),
            storedIngredientsSearchText(ingredients),
            ingredients.length > 0 || instructions.length > 0 ? 1 : 0,
            id,
          ],
        );
      }
      return {
        nextCursor: ids[ids.length - 1]!.id,
        scanned: ids.length,
        done: ids.length < chunkSize,
      };
    },
  },
  {
    // Auto-link ingredients that are themselves recipes in the same collection
    // (component / sub-recipe cross-references). Fill mode: only sets links on
    // ingredients that don't already have one, so a background pass on a
    // partially-synced device can never clear a link another device set, and
    // manual/dismissed rows are left alone. Re-running also links sub-recipes
    // added since the last pass (reverse direction). Touched hosts enqueue a
    // recipe_save so links reach the server. Idempotent: a host whose links
    // don't change is neither rewritten nor re-pushed.
    id: 'ingredient_links_v1',
    async total() {
      const db = await getLocalDb();
      const rows = (await db.execO<{ c: number }>(
        `select count(*) as c from recipes where deleted = 0`,
      )) as { c: number }[];
      return rows[0]?.c ?? 0;
    },
    async step(cursor, chunkSize) {
      const db = await getLocalDb();
      const rows = (await db.execO<{ id: string; title: string; collection_id: string }>(
        `select id, title, collection_id from recipes where deleted = 0 and id > ? order by id limit ?`,
        [cursor, chunkSize],
      )) as { id: string; title: string; collection_id: string }[];
      if (rows.length === 0) return { nextCursor: cursor, scanned: 0, done: true };
      for (const r of rows) {
        const changed = await computeAndApplyLinks(r.id, r.title, r.collection_id);
        if (changed) {
          await enqueue({ kind: 'recipe_save', entity_id: r.id, collection_id: r.collection_id });
        }
      }
      return {
        nextCursor: rows[rows.length - 1]!.id,
        scanned: rows.length,
        done: rows.length < chunkSize,
      };
    },
  },
];

// ---------- the runner ----------

let started = false;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run all pending backfills to completion, off the critical path. Idempotent —
 * safe to call again; finished backfills are skipped. `shouldPause` lets the
 * caller (SyncProvider) hold the runner back while a sync cycle is in flight so
 * a chunk never competes with an active pull.
 */
export async function startBackfills(opts: { shouldPause?: () => boolean } = {}): Promise<void> {
  if (started) return;
  started = true;
  const shouldPause = opts.shouldPause ?? (() => false);

  for (const def of REGISTRY) {
    try {
      const state = await readState(def.id);
      if (state?.status === 'done') {
        progress.set(def.id, {
          id: def.id,
          status: 'done',
          processed: state.processed,
          total: state.processed,
        });
        continue;
      }
      const total = await def.total();
      let cursor = state?.cursor ?? '';
      let processed = state?.processed ?? 0;

      // Nothing to do (fresh/empty DB) — mark done WITHOUT ever entering the
      // running state, so the schema-upgrade overlay never flickers on a fresh
      // install / e2e context.
      if (total === 0) {
        await writeState(def.id, 'done', cursor, processed);
        progress.set(def.id, { id: def.id, status: 'done', processed, total: 0 });
        notify();
        continue;
      }

      progress.set(def.id, { id: def.id, status: 'running', processed, total });
      notify();
      logSync('info', `backfill ${def.id}: start`, { total, processed });

      for (;;) {
        while (shouldPause()) await delay(PAUSE_POLL_MS);
        const { nextCursor, scanned, done } = await def.step(cursor, CHUNK);
        cursor = nextCursor;
        processed += scanned;
        await writeState(def.id, done ? 'done' : 'running', cursor, processed);
        progress.set(def.id, {
          id: def.id,
          status: done ? 'done' : 'running',
          processed,
          total,
        });
        notify();
        if (done) break;
        await delay(CHUNK_GAP_MS);
      }
      logSync('info', `backfill ${def.id}: done`, { processed });
    } catch (err) {
      logSync('warn', `backfill ${def.id}: failed`, { error: (err as Error).message });
      // Leave status as-is (resumable next launch); don't block other backfills.
    }
  }
}
