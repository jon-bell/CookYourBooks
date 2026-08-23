import {
  type CollectionRow,
  collectionToInsert,
  type RecipeRow,
  recipeToInsert,
  rowToCollection,
  rowToRecipe,
  type StoredIngredient,
  storedIngredientsSearchText,
} from '@cookyourbooks/db';
import type {
  CollectionNote,
  CollectionNoteRepository,
  CookingEvent,
  CookingEventRepository,
  Recipe,
  RecipeCollection,
  RecipeCollectionRepository,
  RecipeRepository,
  RecipeSnapshot,
  RecipeTagRepository,
  Tag,
} from '@cookyourbooks/domain';
import {
  createWebCollection,
  EMBEDDING_DIM,
  newTagId,
  normalizeLabel,
} from '@cookyourbooks/domain';

import { CRR_SUPPRESS_MIN_ROWS, shouldSuppressCrrTriggers } from './crrSuppression.js';
import { getLocalDb, type LocalDb } from './db.js';
import { applyLinksToRecipe } from './ingredientLinks.js';
import { enqueue } from './outbox.js';

// Milliseconds since epoch, good enough for a monotonic-ish write marker
// on the local side.
function now(): number {
  return Date.now();
}

/** Upsert a collection row directly (used by both local saves and sync pulls). */
export async function upsertCollectionRow(row: CollectionRow): Promise<void> {
  const db = await getLocalDb();
  const rowX = row as CollectionRow & {
    moderation_state?: string | null;
    moderation_reason?: string | null;
    shared_with_household_id?: string | null;
  };
  await db.exec(
    `insert into recipe_collections
       (id, owner_id, title, source_type, author, isbn, publisher, publication_year,
        description, notes, source_url, date_accessed, site_name,
        is_public, forked_from, cover_image_path,
        moderation_state, moderation_reason, shared_with_household_id,
        updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       title=excluded.title,
       source_type=excluded.source_type,
       author=excluded.author,
       isbn=excluded.isbn,
       publisher=excluded.publisher,
       publication_year=excluded.publication_year,
       description=excluded.description,
       notes=excluded.notes,
       source_url=excluded.source_url,
       date_accessed=excluded.date_accessed,
       site_name=excluded.site_name,
       is_public=excluded.is_public,
       forked_from=excluded.forked_from,
       cover_image_path=excluded.cover_image_path,
       moderation_state=excluded.moderation_state,
       moderation_reason=excluded.moderation_reason,
       shared_with_household_id=excluded.shared_with_household_id,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= recipe_collections.updated_at`,
    [
      row.id,
      row.owner_id,
      row.title,
      row.source_type,
      row.author,
      row.isbn,
      row.publisher,
      row.publication_year,
      row.description,
      row.notes,
      row.source_url,
      row.date_accessed,
      row.site_name,
      row.is_public ? 1 : 0,
      row.forked_from,
      row.cover_image_path,
      rowX.moderation_state ?? 'ACTIVE',
      rowX.moderation_reason ?? null,
      rowX.shared_with_household_id ?? null,
      tsToMs(row.updated_at),
    ],
  );
}

const COLLECTION_COLS = [
  'id',
  'owner_id',
  'title',
  'source_type',
  'author',
  'isbn',
  'publisher',
  'publication_year',
  'description',
  'notes',
  'source_url',
  'date_accessed',
  'site_name',
  'is_public',
  'forked_from',
  'cover_image_path',
  'moderation_state',
  'moderation_reason',
  'shared_with_household_id',
  'updated_at',
  'deleted',
] as const;

function collectionToParams(row: CollectionRow): readonly unknown[] {
  const rowX = row as CollectionRow & {
    moderation_state?: string | null;
    moderation_reason?: string | null;
    shared_with_household_id?: string | null;
  };
  return [
    row.id,
    row.owner_id,
    row.title,
    row.source_type,
    row.author,
    row.isbn,
    row.publisher,
    row.publication_year,
    row.description,
    row.notes,
    row.source_url,
    row.date_accessed,
    row.site_name,
    row.is_public ? 1 : 0,
    row.forked_from,
    row.cover_image_path,
    rowX.moderation_state ?? 'ACTIVE',
    rowX.moderation_reason ?? null,
    rowX.shared_with_household_id ?? null,
    tsToMs(row.updated_at),
    0,
  ];
}

/**
 * Bulk-upsert many collection rows. Same pattern as upsertRecipesBatch:
 * pre-filter by existing updated_at, suppress CRR triggers, multi-row
 * INSERT.
 */
export async function upsertCollectionsBatch(rows: readonly CollectionRow[]): Promise<void> {
  if (rows.length === 0) return;
  const fresh = await filterFresherIncoming(
    'recipe_collections',
    rows,
    (r) => r.id,
    (r) => tsToMs(r.updated_at),
  );
  if (fresh.length === 0) return;
  await withSuppressedCrrTriggers(['recipe_collections'], fresh.length, async () => {
    await bulkInsertOnConflictId('recipe_collections', COLLECTION_COLS, fresh, collectionToParams);
  });
}

// ---------- cooking tracker: per-row upserts ----------
//
// Used by both the realtime owner-filtered handler in sync.ts and the
// local repositories' save paths. Always an owned row: shared_with_household_id
// stays null on insert and is left untouched on conflict, so a household-pull
// marker is never clobbered. The `updated_at >= existing` guard refuses to
// regress a fresher local row with a stale incoming one.

/** Flexible input for upsertCookingEventRow — server row (realtime) or a local save. */
export interface CookingEventUpsertInput {
  id: string;
  owner_id: string;
  recipe_id: string | null;
  status: string;
  event_date: string;
  occasion_category: string | null;
  meal_slot: string | null;
  occasion_note: string | null;
  notes: string | null;
  /** Object (stringified here) or an already-serialized JSON string. */
  adjustments: unknown;
  recipe_snapshot: unknown;
  photo_paths: unknown;
  updated_at: string | number;
}

export async function upsertCookingEventRow(row: CookingEventUpsertInput): Promise<void> {
  const db = await getLocalDb();
  const ts = tsToMs(row.updated_at);
  const adjustments =
    typeof row.adjustments === 'string' ? row.adjustments : JSON.stringify(row.adjustments ?? []);
  const snapshot =
    row.recipe_snapshot === null || row.recipe_snapshot === undefined
      ? null
      : typeof row.recipe_snapshot === 'string'
        ? row.recipe_snapshot
        : JSON.stringify(row.recipe_snapshot);
  const photoPaths =
    typeof row.photo_paths === 'string' ? row.photo_paths : JSON.stringify(row.photo_paths ?? []);
  await db.exec(
    `insert into cooking_events
       (id, owner_id, recipe_id, status, event_date, occasion_category,
        meal_slot, occasion_note, notes, adjustments, recipe_snapshot, photo_paths,
        shared_with_household_id, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       recipe_id=excluded.recipe_id,
       status=excluded.status,
       event_date=excluded.event_date,
       occasion_category=excluded.occasion_category,
       meal_slot=excluded.meal_slot,
       occasion_note=excluded.occasion_note,
       notes=excluded.notes,
       adjustments=excluded.adjustments,
       recipe_snapshot=excluded.recipe_snapshot,
       photo_paths=excluded.photo_paths,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= cooking_events.updated_at`,
    [
      row.id,
      row.owner_id,
      row.recipe_id,
      row.status,
      row.event_date,
      row.occasion_category,
      row.meal_slot,
      row.occasion_note,
      row.notes,
      adjustments,
      snapshot,
      photoPaths,
      ts,
    ],
  );
}

export interface RecipeTagUpsertInput {
  id: string;
  owner_id: string;
  recipe_id: string;
  label: string;
  updated_at: string | number;
}

export async function upsertRecipeTagRow(row: RecipeTagUpsertInput): Promise<void> {
  const db = await getLocalDb();
  const ts = tsToMs(row.updated_at);
  await db.exec(
    `insert into recipe_tags
       (id, owner_id, recipe_id, label, shared_with_household_id, updated_at, deleted)
     values (?,?,?,?,NULL,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       recipe_id=excluded.recipe_id,
       label=excluded.label,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= recipe_tags.updated_at`,
    [row.id, row.owner_id, row.recipe_id, row.label, ts],
  );
}

export interface CollectionNoteUpsertInput {
  id: string;
  collection_id: string | null;
  owner_id: string;
  import_item_id: string | null;
  title: string;
  body: string;
  source_image_text: string | null;
  page_numbers: number[] | null;
  sort_order: number;
  updated_at: string | number;
}

/** Upsert an owner's own collection_note (realtime path). Co-member notes come
 *  through the household pull, which sets shared_with_household_id — here it's
 *  always NULL (this is one of my own rows). */
export async function upsertCollectionNoteRow(row: CollectionNoteUpsertInput): Promise<void> {
  const db = await getLocalDb();
  const ts = tsToMs(row.updated_at);
  await db.exec(
    `insert into collection_notes
       (id, collection_id, owner_id, import_item_id, title, body, source_image_text,
        page_numbers, sort_order, shared_with_household_id, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,NULL,?,0)
     on conflict(id) do update set
       collection_id=excluded.collection_id,
       owner_id=excluded.owner_id,
       import_item_id=excluded.import_item_id,
       title=excluded.title,
       body=excluded.body,
       source_image_text=excluded.source_image_text,
       page_numbers=excluded.page_numbers,
       sort_order=excluded.sort_order,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= collection_notes.updated_at`,
    [
      row.id,
      row.collection_id,
      row.owner_id,
      row.import_item_id,
      row.title,
      row.body,
      row.source_image_text,
      JSON.stringify(row.page_numbers ?? []),
      row.sort_order,
      ts,
    ],
  );
}

/**
 * Upsert a single recipe row. Children ride as JSON on the row itself
 * (`ingredients` / `instructions`); {@link bulkUpsertRecipes} maintains the
 * folded JSON columns plus the local-only `ingredients_text` search column and
 * `has_content`. Refuses to regress a fresher local row with a stale write.
 */
export async function upsertRecipeRow(recipeRow: RecipeRow): Promise<void> {
  const db = await getLocalDb();
  const incomingTs = tsToMs(recipeRow.updated_at);
  const existing = (await db.execO<{ updated_at: number }>(
    `select updated_at from recipes where id = ?`,
    [recipeRow.id],
  )) as { updated_at: number }[];
  if (existing[0] && existing[0].updated_at > incomingTs) return;
  await db.tx(async (tx) => {
    await bulkUpsertRecipes(tx, [recipeRow]);
  });
}

/**
 * Bulk-upsert many recipes (and their children) using multi-row VALUES
 * inserts and batched IN-list deletes. The per-row WASM round-trip cost
 * is the dominant factor on iPad SQLite, so collapsing thousands of
 * single-row INSERTs into a handful of multi-row statements cuts a
 * fresh-library pull from tens of seconds down to seconds.
 *
 * The per-recipe updated_at guard is applied via a single SELECT-IN
 * lookup at the top, then stale rows are filtered out before any
 * writes — preserving the "refuse to regress a fresher local row"
 * semantic without paying for a separate round-trip per recipe.
 */
/**
 * The CRR tables we write to during a pull. Wrapping the bulk-insert
 * tx with crsql_begin_alter / crsql_commit_alter on each suppresses
 * cr-sqlite's per-row change-tracking triggers for the duration —
 * pulls are server-canonical and don't need to be re-propagated as
 * outbound CRDT changes, so the trigger work is pure overhead. On
 * iPad WASM SQLite each trigger fire is ~10–15ms; disabling them
 * collapses an 87-recipe pull from ~38s to seconds.
 */
// Children are folded into recipes.ingredients / recipes.instructions JSON, so
// a recipe pull writes exactly one CRR table now.
export const PULL_CRR_TABLES = ['recipes'] as const;

/**
 * Largest current row count among `tables`. commit_alter scans the whole
 * table, so its cost is dominated by the biggest one (ingredients, in the
 * recipe family). count(*) walks the rowid b-tree — a few ms even at 160k
 * rows, and only ever run once we're already above the row floor, so it's
 * negligible against the commit_alter it's deciding whether to pay.
 */
async function maxCrrTableRows(db: LocalDb, tables: readonly string[]): Promise<number> {
  let max = 0;
  for (const t of tables) {
    const rows = await db.execA<[number]>(`select count(*) from ${t}`);
    max = Math.max(max, Number(rows[0]?.[0] ?? 0));
  }
  return max;
}

/**
 * Run `fn` with cr-sqlite's per-row change-tracking triggers suspended
 * on `tables`. cr-sqlite's crsql_begin_alter / crsql_commit_alter pair
 * drops the row triggers for the duration and recreates them on
 * commit_alter — exactly the property a *bulk* pull needs, since pulled
 * rows are server-canonical and don't need to be re-propagated as
 * outbound CRDT changes.
 *
 * `rowCount` is the number of rows `fn` is about to write. The decision to
 * suppress is *size-relative* (see {@link shouldSuppressCrrTriggers}):
 * commit_alter is O(table size), so we only pay it when `rowCount` is a big
 * enough fraction of the largest target table to amortise a full-table scan.
 * Below {@link CRR_SUPPRESS_MIN_ROWS} we short-circuit without even probing
 * the table sizes — tiny batches (realtime echoes) always run with triggers
 * live. Pass the total row count across all `tables` (e.g. recipes +
 * ingredients + instructions + refs), since that's what the trigger cost
 * tracks.
 *
 * Must run at the top level (not inside a SAVEPOINT / db.tx callback) so
 * the triggers re-attach cleanly even on caller failure.
 */
export async function withSuppressedCrrTriggers<T>(
  tables: readonly string[],
  rowCount: number,
  fn: () => Promise<T>,
): Promise<T> {
  // Cheap floor first: tiny batches never suppress, and we avoid the
  // count() probe entirely on the hot incremental/echo path.
  if (rowCount < CRR_SUPPRESS_MIN_ROWS) {
    return await fn();
  }
  const db = await getLocalDb();
  // commit_alter rebuilds the whole CRDT clock, so its cost tracks the
  // LARGEST target table, not the batch. Probe current sizes and only
  // suppress when the batch is a big enough fraction to be worth it.
  const maxTableRows = await maxCrrTableRows(db, tables);
  if (!shouldSuppressCrrTriggers(rowCount, maxTableRows)) {
    return await fn();
  }
  const altered: string[] = [];
  try {
    for (const t of tables) {
      await db.exec(`select crsql_begin_alter('${t}')`);
      altered.push(t);
    }
    return await fn();
  } finally {
    // Always reattach triggers, even if fn threw, so subsequent local
    // writes are tracked normally. Reverse order so the recreated
    // triggers don't see ghost pre-images.
    for (let i = altered.length - 1; i >= 0; i -= 1) {
      try {
        await db.exec(`select crsql_commit_alter('${altered[i]}')`);
      } catch {
        // Swallow so we don't mask the original error.
      }
    }
  }
}

/**
 * Pre-filter an upsert batch by reading each row's existing local
 * `updated_at` in one IN-list SELECT and dropping rows whose local
 * copy is strictly newer. Preserves the "refuse to regress a fresher
 * local row" invariant when we want to write multi-row INSERTs that
 * can't easily express the guard in `ON CONFLICT WHERE`.
 *
 * Returns the rows that should actually be written.
 */
export async function filterFresherIncoming<T>(
  table: string,
  rows: readonly T[],
  idOf: (row: T) => string,
  incomingTsMs: (row: T) => number,
): Promise<T[]> {
  if (rows.length === 0) return [];
  const db = await getLocalDb();
  const existingMap = new Map<string, number>();
  // SQLite host-parameter ceiling — chunk to stay safe.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const ids = slice.map(idOf);
    const placeholders = ids.map(() => '?').join(',');
    const found = await db.execO<{ id: string; updated_at: number }>(
      `select id, updated_at from ${table} where id in (${placeholders})`,
      ids,
    );
    for (const r of found) existingMap.set(r.id, r.updated_at);
  }
  return rows.filter((row) => {
    const local = existingMap.get(idOf(row));
    return !local || local <= incomingTsMs(row);
  });
}

/**
 * A recipe batch is just its recipe rows now — ingredients / instructions ride
 * as JSON on each row.
 */
export type RecipeBatchEntry = RecipeRow;

/** Total rows a recipe batch writes — one per recipe now that children fold in. */
export function recipeBatchRowCount(batch: ReadonlyArray<RecipeBatchEntry>): number {
  return batch.length;
}

/**
 * Upsert one recipe chunk in a single tx, assuming the caller already holds
 * the CRR-trigger suppression. Use this when draining a large pull in
 * checkpointed chunks under ONE {@link withSuppressedCrrTriggers} boundary:
 * `crsql_commit_alter` is O(table size), so suppressing per-chunk pays that
 * full-table cost once per chunk. Callers writing a small one-off batch
 * (realtime echoes) should use {@link upsertRecipesBatch}, which manages the
 * boundary itself.
 */
export async function upsertRecipesBatchInner(
  batch: ReadonlyArray<RecipeBatchEntry>,
  signal?: AbortSignal,
): Promise<void> {
  if (batch.length === 0) return;
  if (signal?.aborted) return;
  const db = await getLocalDb();
  await db.tx(async (tx) => {
    const ids = batch.map((b) => b.id);
    const existingMap = new Map<string, number>();
    const placeholders = ids.map(() => '?').join(',');
    const rows = await tx.execO<{ id: string; updated_at: number }>(
      `select id, updated_at from recipes where id in (${placeholders})`,
      ids,
    );
    for (const r of rows) existingMap.set(r.id, r.updated_at);

    const fresh = batch.filter((b) => {
      const local = existingMap.get(b.id);
      return !local || local <= tsToMs(b.updated_at);
    });
    if (fresh.length === 0) return;

    await bulkUpsertRecipes(tx, fresh);
  });
}

/**
 * Upsert ONLY the `recipes` rows of a batch — no child delete/insert.
 *
 * The library-snapshot full-pull lands in two stages: the `meta` stage
 * writes recipe cards so the grid renders immediately, then the `bodies`
 * stage fills in ingredients / instructions / refs. Routing the meta
 * stage through {@link upsertRecipesBatchInner} would delete each recipe's
 * children (it replaces them), which is wrong here — the children just
 * haven't arrived yet. This writes the recipe rows alone (a single bulk
 * statement), leaving any children untouched; the bodies stage then calls
 * {@link upsertRecipesBatchInner} to attach them. Keeps the same
 * "refuse to regress a fresher local row" guard as the full path.
 */
export async function upsertRecipeRowsOnly(
  rows: readonly RecipeRow[],
  signal?: AbortSignal,
): Promise<void> {
  if (rows.length === 0 || signal?.aborted) return;
  await withSuppressedCrrTriggers(['recipes'], rows.length, async () => {
    const db = await getLocalDb();
    await db.tx(async (tx) => {
      const ids = rows.map((r) => r.id);
      const existingMap = new Map<string, number>();
      const CHUNK = 500;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const ph = slice.map(() => '?').join(',');
        const found = await tx.execO<{ id: string; updated_at: number }>(
          `select id, updated_at from recipes where id in (${ph})`,
          slice,
        );
        for (const r of found) existingMap.set(r.id, r.updated_at);
      }
      const fresh = rows.filter((r) => {
        const local = existingMap.get(r.id);
        return !local || local <= tsToMs(r.updated_at);
      });
      await bulkUpsertRecipes(tx, fresh);
    });
  });
}

/**
 * Attach folded children (ingredients / instructions JSON) onto already-written
 * recipe rows — the library-snapshot `bodies` stage. The `meta` stage writes
 * recipe cards (JSON columns left null so the grid renders immediately, but
 * `has_content` carried through for the placeholder badge); this fills the JSON
 * in and recomputes the local-only `ingredients_text` search column.
 */
export async function updateRecipeBodies(
  rows: readonly { id: string; ingredients: unknown; instructions: unknown }[],
  signal?: AbortSignal,
): Promise<void> {
  if (rows.length === 0 || signal?.aborted) return;
  await withSuppressedCrrTriggers(['recipes'], rows.length, async () => {
    const db = await getLocalDb();
    await db.tx(async (tx) => {
      for (const r of rows) {
        const ingredients = parseJsonArray(r.ingredients) as StoredIngredient[];
        await tx.exec(
          `update recipes set ingredients = ?, instructions = ?, ingredients_text = ?
             where id = ?`,
          [
            toJsonText(r.ingredients),
            toJsonText(r.instructions),
            storedIngredientsSearchText(ingredients),
            r.id,
          ],
        );
      }
    });
  });
}

/**
 * Upsert a recipe batch under its own CRR-trigger suppression boundary.
 * Convenience wrapper for one-off callers (realtime echoes); the chunked
 * pull path instead holds one boundary across all chunks and calls
 * {@link upsertRecipesBatchInner} directly.
 */
export async function upsertRecipesBatch(
  batch: ReadonlyArray<RecipeBatchEntry>,
  signal?: AbortSignal,
): Promise<void> {
  if (batch.length === 0) return;
  if (signal?.aborted) return;
  await withSuppressedCrrTriggers(PULL_CRR_TABLES, recipeBatchRowCount(batch), () =>
    upsertRecipesBatchInner(batch, signal),
  );
}

interface RecipeTx {
  exec: (sql: string, bind?: unknown[]) => Promise<unknown>;
  execO: (sql: string, bind?: unknown[]) => Promise<unknown[]>;
}

// Multi-row INSERT chunk size — only here to stay under SQLite's
// SQLITE_MAX_VARIABLE_NUMBER (32766 in modern builds). With the widest
// table (recipes, 20 cols), 1500 rows × 20 cols = 30000 params, safely
// under the cap. For libraries up to ~1500 recipes this is one INSERT
// statement per table.
const MAX_ROWS_PER_INSERT = 1500;

/**
 * Generic multi-row INSERT ... ON CONFLICT(id) DO UPDATE helper for
 * tail tables (imports, conversion_rules, rewrite_jobs, etc). Builds
 * one statement per chunk of `MAX_ROWS_PER_INSERT / cols.length` rows
 * to stay under SQLite's host-parameter ceiling. Use with
 * `withSuppressedCrrTriggers` for the CRR-trigger-disable speedup.
 *
 * Caller is responsible for pre-filtering via `filterFresherIncoming`
 * if the table has an `updated_at` regress guard — replicating that
 * guard inside `ON CONFLICT WHERE` is supported by SQLite, but the
 * pre-filter shape composes better with the read-once-per-batch
 * pattern the recipe path uses.
 */
export async function bulkInsertOnConflictId<T>(
  table: string,
  cols: readonly string[],
  rows: readonly T[],
  toParams: (row: T) => readonly unknown[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getLocalDb();
  const tuple = `(${cols.map(() => '?').join(',')})`;
  const setClause = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c}=excluded.${c}`)
    .join(', ');
  const rowsPerChunk = Math.max(1, Math.floor(MAX_ROWS_PER_INSERT / cols.length));
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const chunk = rows.slice(i, i + rowsPerChunk);
    const params: unknown[] = [];
    for (const row of chunk) {
      const vals = toParams(row);
      if (vals.length !== cols.length) {
        throw new Error(
          `bulkInsertOnConflictId(${table}): row produced ${vals.length} params, expected ${cols.length}`,
        );
      }
      for (const v of vals) params.push(v);
    }
    const placeholders = chunk.map(() => tuple).join(',');
    await db.exec(
      `insert into ${table} (${cols.join(',')}) values ${placeholders}
       on conflict(id) do update set ${setClause}`,
      params as never[],
    );
  }
}

/**
 * Variant for append-only tables that have no `id` conflict pattern
 * worth updating — used by `import_item_attempts` which is server-side
 * append-only and uses `INSERT ... ON CONFLICT DO NOTHING` semantically.
 */
export async function bulkInsertIgnoreId<T>(
  table: string,
  cols: readonly string[],
  rows: readonly T[],
  toParams: (row: T) => readonly unknown[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getLocalDb();
  const tuple = `(${cols.map(() => '?').join(',')})`;
  const rowsPerChunk = Math.max(1, Math.floor(MAX_ROWS_PER_INSERT / cols.length));
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const chunk = rows.slice(i, i + rowsPerChunk);
    const params: unknown[] = [];
    for (const row of chunk) {
      const vals = toParams(row);
      for (const v of vals) params.push(v);
    }
    const placeholders = chunk.map(() => tuple).join(',');
    await db.exec(
      `insert into ${table} (${cols.join(',')}) values ${placeholders}
       on conflict(id) do nothing`,
      params as never[],
    );
  }
}

async function bulkUpsertRecipes(tx: RecipeTx, recipes: readonly RecipeRow[]): Promise<void> {
  if (recipes.length === 0) return;
  const cols = [
    'id',
    'collection_id',
    'title',
    'servings_amount',
    'servings_description',
    'servings_amount_max',
    'sort_order',
    'notes',
    'parent_recipe_id',
    'description',
    'time_estimate',
    'equipment',
    'book_title',
    'page_numbers',
    'source_image_text',
    'source_url',
    'starred',
    'cover_image_path',
    'ingredients',
    'instructions',
    'ingredients_text',
    'has_content',
    'updated_at',
    'deleted',
  ];
  const valuesTuple = `(${cols.map(() => '?').join(',')})`;
  const setClause = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c}=excluded.${c}`)
    .join(',\n      ');
  for (let i = 0; i < recipes.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = recipes.slice(i, i + MAX_ROWS_PER_INSERT);
    const params: unknown[] = [];
    for (const r of chunk) {
      const rx = r as RecipeRow & {
        notes?: string | null;
        parent_recipe_id?: string | null;
        servings_amount_max?: number | null;
        description?: string | null;
        time_estimate?: string | null;
        equipment?: unknown;
        book_title?: string | null;
        page_numbers?: unknown;
        source_image_text?: string | null;
        source_url?: string | null;
        starred?: boolean | number | null;
        cover_image_path?: string | null;
        ingredients?: unknown;
        instructions?: unknown;
      };
      const starredRaw: unknown = rx.starred;
      const ingText = storedIngredientsSearchText(
        parseJsonArray(rx.ingredients) as StoredIngredient[],
      );
      params.push(
        r.id,
        r.collection_id,
        r.title,
        r.servings_amount,
        r.servings_description,
        rx.servings_amount_max ?? null,
        r.sort_order,
        rx.notes ?? null,
        rx.parent_recipe_id ?? null,
        rx.description ?? null,
        rx.time_estimate ?? null,
        toJsonText(rx.equipment),
        rx.book_title ?? null,
        toJsonText(rx.page_numbers),
        rx.source_image_text ?? null,
        rx.source_url ?? null,
        starredRaw === true || starredRaw === 1 ? 1 : 0,
        rx.cover_image_path ?? null,
        toJsonText(rx.ingredients),
        toJsonText(rx.instructions),
        ingText.length > 0 ? ingText : null,
        r.has_content === true || (r.has_content as unknown) === 1 ? 1 : 0,
        tsToMs(r.updated_at),
        0,
      );
    }
    const placeholders = chunk.map(() => valuesTuple).join(',');
    await tx.exec(
      `insert into recipes (${cols.join(',')}) values ${placeholders}
       on conflict(id) do update set
       ${setClause}`,
      params,
    );
  }
}

/**
 * Normalize an array-ish column value to JSON text suitable for a
 * local SQLite TEXT column. Accepts an already-stringified JSON blob
 * (pass-through), a native array (JSON-encode), or null/undefined.
 */
function toJsonText(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val.length > 0 ? val : null;
  if (Array.isArray(val)) return val.length > 0 ? JSON.stringify(val) : null;
  return null;
}

/** Parse an array-ish JSON column (native array from jsonb, or JSON text from
 *  the local mirror) into a plain array. Empty / malformed → []. */
function parseJsonArray(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.length > 0) {
    try {
      const p: unknown = JSON.parse(val);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function softDeleteCollection(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(`update recipe_collections set deleted = 1, updated_at = ? where id = ?`, [
    now(),
    id,
  ]);
}

export async function softDeleteRecipe(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(`update recipes set deleted = 1, updated_at = ? where id = ?`, [now(), id]);
}

export async function purgeCollection(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.tx(async (tx) => {
    // Children ride as JSON on the recipe row — deleting the recipes is enough.
    await tx.exec(`delete from recipes where collection_id = ?`, [id]);
    await tx.exec(`delete from recipe_collections where id = ?`, [id]);
  });
}

export async function purgeRecipe(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(`delete from recipes where id = ?`, [id]);
}

// ------------- Domain-facing repositories -------------

/** Lightweight row for cookbook pickers — no recipe hydration. */
export interface CollectionPickerOption {
  id: string;
  title: string;
  /** Cookbooks carry an author; personal + web collections don't. */
  author: string | null;
  sourceType: CollectionRow['source_type'];
  /** Number of recipes already saved into this collection. Used to
   *  disambiguate near-empty placeholders from established cookbooks
   *  in the picker. */
  recipeCount: number;
  /** Subset of recipeCount that have at least one ingredient or one
   *  instruction. Anything else is a ToC placeholder waiting for OCR
   *  or hand-entry. Pickers / library cards lead with cookbooks that
   *  have a non-zero value here. */
  filledRecipeCount: number;
}

/** Library grid card — metadata + recipe count, no recipe hydration. */
export interface LibraryCollectionSummary {
  id: string;
  title: string;
  coverImagePath: string | null;
  isPublic: boolean;
  sourceType: CollectionRow['source_type'];
  author: string | null;
  siteName: string | null;
  recipeCount: number;
  filledRecipeCount: number;
  /** Latest COOKED cooking_event date ('YYYY-MM-DD') across the collection's
   *  recipes, null when nothing in it has been made. Drives the library
   *  grid's "Recently made" sort. */
  lastMadeAt: string | null;
}

/**
 * One recipe's worth of metadata for the per-collection browse view: enough
 * to render the cover/list/index cards, filter by title or ingredient name,
 * and drive the star/placeholder UI — without hydrating the full recipe graph
 * (ingredients/instructions/refs) for every row.
 */
export interface CollectionRecipeSummary {
  id: string;
  title: string;
  coverImagePath: string | null;
  pageNumbers: number[];
  sortOrder: number;
  starred: boolean;
  ingredientCount: number;
  instructionCount: number;
  /** newline-joined, lowercased ingredient names — powers the filter box. */
  ingredientNames: string;
}

/** A recipe card for the library-wide gallery: enough to render a cover card
 *  and filter by recipe or by book, plus local view stats for sorting. */
export interface GalleryRecipeSummary {
  id: string;
  title: string;
  coverImagePath: string | null;
  pageNumbers: number[];
  collectionId: string;
  collectionTitle: string;
  collectionAuthor: string | null;
  starred: boolean;
  viewCount: number;
  lastViewedAt: number | null;
}

export class LocalRecipeCollectionRepository implements RecipeCollectionRepository {
  constructor(private readonly ownerId: string) {}

  /** Fast list for dropdowns; avoids hydrating every recipe in every collection. */
  async listPickerOptions(): Promise<CollectionPickerOption[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<{
      id: string;
      title: string;
      author: string | null;
      source_type: CollectionRow['source_type'];
      recipe_count: number;
      filled_count: number;
    }>(
      `select c.id, c.title, c.author, c.source_type,
              coalesce(rc.cnt, 0) as recipe_count,
              coalesce(fc.cnt, 0) as filled_count
         from recipe_collections c
         left join (
           select collection_id, count(*) as cnt
             from recipes
             where deleted = 0
             group by collection_id
         ) rc on rc.collection_id = c.id
         left join (
           select r.collection_id, count(*) as cnt
             from recipes r
             where r.deleted = 0 and r.has_content = 1
             group by r.collection_id
         ) fc on fc.collection_id = c.id
        where c.owner_id = ? and c.deleted = 0
        order by (filled_count > 0) desc, lower(c.title) asc`,
      [this.ownerId],
    )) as Array<{
      id: string;
      title: string;
      author: string | null;
      source_type: CollectionRow['source_type'];
      recipe_count: number;
      filled_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      sourceType: r.source_type,
      recipeCount: r.recipe_count,
      filledRecipeCount: r.filled_count,
    }));
  }

  /** Fast list for the library grid — one grouped query, no per-recipe hydration. */
  async listLibrarySummaries(): Promise<LibraryCollectionSummary[]> {
    const db = await getLocalDb();
    // filled_count counts recipes that have at least one ingredient or
    // one instruction — i.e. the user has imported or written real
    // content. Anything else is a placeholder seeded from the global
    // cookbook catalog. Ordering by (filled_count > 0) desc keeps the
    // library "populated" cookbooks on top, regardless of when the
    // skeleton was created.
    const rows = (await db.execO<{
      id: string;
      title: string;
      cover_image_path: string | null;
      is_public: number | boolean;
      source_type: CollectionRow['source_type'];
      author: string | null;
      site_name: string | null;
      recipe_count: number;
      filled_count: number;
      last_made: string | null;
    }>(
      // recipe_count + filled_count in ONE indexed pass over recipes via the
      // materialized has_content flag — replaces the old per-recipe correlated
      // EXISTS subqueries that scanned ingredients/instructions for every row
      // and held the single cr-sqlite connection for minutes on a household-
      // sized library (Sentry CYB-CAPACITOR-3). Rides recipes_collection_active_idx.
      // last_made = newest COOKED cooking_event across the collection's
      // recipes; powers the "Recently made" library sort.
      `select c.id, c.title, c.cover_image_path, c.is_public, c.source_type,
              c.author, c.site_name,
              coalesce(rc.cnt, 0) as recipe_count,
              coalesce(rc.filled, 0) as filled_count,
              lm.last_made as last_made
       from recipe_collections c
       left join (
         select collection_id,
                count(*) as cnt,
                sum(has_content) as filled
           from recipes
           where deleted = 0
           group by collection_id
       ) rc on rc.collection_id = c.id
       left join (
         select r.collection_id, max(ce.event_date) as last_made
           from cooking_events ce
           join recipes r on r.id = ce.recipe_id and r.deleted = 0
          where ce.deleted = 0 and ce.status = 'COOKED'
          group by r.collection_id
       ) lm on lm.collection_id = c.id
       where (c.owner_id = ? or c.shared_with_household_id is not null)
         and c.deleted = 0
       order by (coalesce(rc.filled, 0) > 0) desc, coalesce(c.updated_at, 0) desc`,
      [this.ownerId],
    )) as {
      id: string;
      title: string;
      cover_image_path: string | null;
      is_public: number | boolean;
      source_type: CollectionRow['source_type'];
      author: string | null;
      site_name: string | null;
      recipe_count: number;
      filled_count: number;
      last_made: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      coverImagePath: row.cover_image_path,
      isPublic: Boolean(row.is_public),
      sourceType: row.source_type,
      author: row.author,
      siteName: row.site_name,
      recipeCount: Number(row.recipe_count),
      filledRecipeCount: Number(row.filled_count),
      lastMadeAt: row.last_made,
    }));
  }

  /**
   * Every non-empty recipe across the visible library (own + household-shared)
   * for the library-wide gallery, default-sorted by personal view frequency
   * then recency. Lightweight: title + cover + page + owning book only — no
   * ingredient/instruction hydration. `recipe_views` is the local-only,
   * never-synced view log; it left-joins so never-viewed recipes still appear
   * (falling to the bottom, then title order).
   */
  async listGalleryRecipes(): Promise<GalleryRecipeSummary[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<{
      id: string;
      title: string;
      cover_image_path: string | null;
      page_numbers: string | null;
      collection_id: string;
      collection_title: string;
      collection_author: string | null;
      view_count: number;
      last_viewed: number | null;
    }>(
      `select r.id, r.title, r.cover_image_path, r.page_numbers, r.collection_id, r.starred,
              c.title as collection_title, c.author as collection_author,
              coalesce(v.cnt, 0) as view_count, v.last_viewed
         from recipes r
         join recipe_collections c on c.id = r.collection_id and c.deleted = 0
         left join (
           select recipe_id, count(*) as cnt, max(viewed_at) as last_viewed
             from recipe_views group by recipe_id
         ) v on v.recipe_id = r.id
        where r.deleted = 0 and r.has_content = 1
          and (c.owner_id = ? or c.shared_with_household_id is not null)
        order by (view_count > 0) desc, view_count desc, v.last_viewed desc, lower(r.title) asc`,
      [this.ownerId],
    )) as Array<{
      id: string;
      title: string;
      cover_image_path: string | null;
      page_numbers: string | null;
      collection_id: string;
      collection_title: string;
      collection_author: string | null;
      starred: number | boolean;
      view_count: number;
      last_viewed: number | null;
    }>;
    return rows.map((r) => {
      let pageNumbers: number[] = [];
      try {
        const parsed: unknown = JSON.parse(r.page_numbers || '[]');
        if (Array.isArray(parsed))
          pageNumbers = parsed.filter((x): x is number => typeof x === 'number');
      } catch {
        // leave empty
      }
      return {
        id: r.id,
        title: r.title,
        coverImagePath: r.cover_image_path,
        pageNumbers,
        collectionId: r.collection_id,
        collectionTitle: r.collection_title,
        collectionAuthor: r.collection_author,
        starred: r.starred === 1 || r.starred === true,
        viewCount: Number(r.view_count),
        lastViewedAt: r.last_viewed,
      };
    });
  }

  async list(): Promise<RecipeCollection[]> {
    const db = await getLocalDb();
    // Includes household-shared collections from other members; pullAll
    // only places visible-to-me collections in local SQLite so a simple
    // OR is sufficient.
    const colRows = await db.execO<CollectionRow>(
      `select * from recipe_collections
       where (owner_id = ? or shared_with_household_id is not null) and deleted = 0
       order by coalesce(updated_at, 0) desc`,
      [this.ownerId],
    );
    return Promise.all(colRows.map((row) => hydrateCollection(row)));
  }

  async get(id: string): Promise<RecipeCollection | undefined> {
    const db = await getLocalDb();
    const rows = await db.execO<CollectionRow>(
      `select * from recipe_collections where id = ? and deleted = 0`,
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;
    return hydrateCollection(row);
  }

  /**
   * Collection metadata only — same row fetch + visibility filter as
   * {@link get}, but the returned RecipeCollection carries `recipes: []`
   * instead of hydrating every recipe's full graph. The per-collection
   * browse view reads its recipe cards from
   * {@link listCollectionRecipeSummaries} instead, so the page no longer
   * pays to materialize hundreds of ingredient/instruction trees just to
   * render titles + covers. Spreading this meta object into a
   * `saveCollection` mutation is also the cheap path for publish/cover/
   * share toggles: `save` only ever upserts the recipes it's handed, so an
   * empty list skips the per-recipe re-save + outbox churn.
   */
  async getMeta(id: string): Promise<RecipeCollection | undefined> {
    const db = await getLocalDb();
    const rows = await db.execO<CollectionRow>(
      `select * from recipe_collections where id = ? and deleted = 0`,
      [id],
    );
    const row = rows[0];
    if (!row) return undefined;
    return rowToCollection(row, []);
  }

  /**
   * Lightweight per-recipe cards for one collection's browse view — title +
   * cover + page + star + child counts + lowercased ingredient names, in ONE
   * statement. Mirrors {@link hydrateCollection}'s ordering exactly
   * (content-first via the same predicate, then sort_order) and its
   * deleted-row filter, so swapping the page off full hydration leaves the
   * visible order unchanged. Placeholder semantics downstream are
   * `ingredientCount === 0 && instructionCount === 0`.
   */
  async listCollectionRecipeSummaries(collectionId: string): Promise<CollectionRecipeSummary[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<{
      id: string;
      title: string;
      cover_image_path: string | null;
      page_numbers: string | null;
      sort_order: number;
      starred: number | boolean;
      ingredients: string | null;
      instructions: string | null;
      ingredient_names: string;
    }>(
      `select r.id, r.title, r.cover_image_path, r.page_numbers, r.sort_order, r.starred,
              r.has_content, r.ingredients, r.instructions,
              coalesce(r.ingredients_text, '') as ingredient_names
         from recipes r
        where r.collection_id = ? and r.deleted = 0
        order by r.has_content desc, r.sort_order asc`,
      [collectionId],
    )) as Array<{
      id: string;
      title: string;
      cover_image_path: string | null;
      page_numbers: string | null;
      sort_order: number;
      starred: number | boolean;
      ingredients: string | null;
      instructions: string | null;
      ingredient_names: string;
    }>;
    return rows.map((r) => {
      let pageNumbers: number[] = [];
      try {
        const parsed: unknown = JSON.parse(r.page_numbers || '[]');
        if (Array.isArray(parsed)) {
          pageNumbers = parsed.filter((x): x is number => typeof x === 'number');
        }
      } catch {
        // leave empty
      }
      return {
        id: r.id,
        title: r.title,
        coverImagePath: r.cover_image_path,
        pageNumbers,
        sortOrder: Number(r.sort_order),
        starred: r.starred === true || r.starred === 1,
        ingredientCount: parseJsonArray(r.ingredients).length,
        instructionCount: parseJsonArray(r.instructions).length,
        ingredientNames: r.ingredient_names,
      };
    });
  }

  /**
   * SQL-backed library search — title OR any ingredient name, case
   * insensitive. Returns lightweight hits and does NOT hydrate recipe
   * graphs (the old SearchPage hydrated the entire library into JS just
   * to read titles + match ingredient names, saturating the single
   * cr-sqlite connection on large libraries). An empty query returns
   * every recipe, so callers can reuse it as a plain recipe list.
   * Placeholders (no ingredients and no instructions) sort last, matching
   * the previous in-memory ranking.
   *
   * `limit` caps the rows crossing the wasm boundary. The scan itself is
   * linear either way, but marshaling every match is not: on a 16k-recipe
   * library a one-character query matches everything and costs ~130ms
   * unbounded versus ~30ms capped. Callers that use this as a plain recipe
   * list (empty query) leave it unset and still get everything.
   */
  async searchRecipes(query: string, limit?: number): Promise<RecipeSearchHit[]> {
    const db = await getLocalDb();
    const q = query.trim().toLowerCase();
    const params: unknown[] = [this.ownerId];
    let filter = '';
    if (q) {
      const like = `%${escapeLike(q)}%`;
      filter = ` and (lower(r.title) like ? escape '\\'
                 or r.ingredients_text like ? escape '\\')`;
      params.push(like, like);
    }
    const rows = (await db.execO<{
      id: string;
      title: string;
      collection_id: string;
      collection_title: string;
      source_type: CollectionRow['source_type'];
      has_content: number;
    }>(
      `select r.id, r.title, r.collection_id,
              c.title as collection_title, c.source_type,
              r.has_content
         from recipes r
         join recipe_collections c on c.id = r.collection_id
        where r.deleted = 0 and c.deleted = 0
          and (c.owner_id = ? or c.shared_with_household_id is not null)
          ${filter}
        order by has_content desc, c.title asc, r.sort_order asc
        ${limit && limit > 0 ? 'limit ?' : ''}`,
      (limit && limit > 0 ? [...params, Math.floor(limit)] : params) as (string | number)[],
    )) as Array<{
      id: string;
      title: string;
      collection_id: string;
      collection_title: string;
      source_type: CollectionRow['source_type'];
      has_content: number;
    }>;
    return rows.map((r) => ({
      recipeId: r.id,
      recipeTitle: r.title,
      collectionId: r.collection_id,
      collectionTitle: r.collection_title,
      sourceType: r.source_type,
      isPlaceholder: !r.has_content,
    }));
  }

  async save(collection: RecipeCollection): Promise<void> {
    const insert = collectionToInsert(collection, this.ownerId);
    const row: CollectionRow = {
      ...insert,
      owner_id: this.ownerId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_public: insert.is_public ?? false,
      author: insert.author ?? null,
      isbn: insert.isbn ?? null,
      publisher: insert.publisher ?? null,
      publication_year: insert.publication_year ?? null,
      description: insert.description ?? null,
      notes: insert.notes ?? null,
      source_url: insert.source_url ?? null,
      date_accessed: insert.date_accessed ?? null,
      site_name: insert.site_name ?? null,
      cover_image_path: insert.cover_image_path ?? null,
      forked_from: insert.forked_from ?? null,
    } as CollectionRow;
    await upsertCollectionRow(row);

    // Also upsert all recipes the collection carries, so create flows work.
    for (let i = 0; i < collection.recipes.length; i += 1) {
      const recipe = collection.recipes[i]!;
      await saveLocalRecipe(collection.id, recipe, i);
      await enqueue({
        kind: 'recipe_save',
        entity_id: recipe.id,
        collection_id: collection.id,
      });
    }

    await enqueue({ kind: 'collection_save', entity_id: collection.id });
  }

  /**
   * Resolve the generic per-platform WebCollection a video-imported
   * recipe lands in (e.g. "YouTube"), creating it on first use. Matches
   * an existing WEBSITE collection by exact title so repeated imports
   * from the same platform reuse one collection rather than spawning a
   * duplicate. Returns the collection id.
   */
  async findOrCreateWebCollectionByPlatform(platform: string): Promise<string> {
    const db = await getLocalDb();
    const existing = (await db.execO<{ id: string }>(
      `select id from recipe_collections
        where owner_id = ? and deleted = 0
          and source_type = 'WEBSITE' and title = ?
        order by coalesce(updated_at, 0) asc
        limit 1`,
      [this.ownerId, platform],
    )) as { id: string }[];
    if (existing[0]) return existing[0].id;
    const collection = createWebCollection({ title: platform, siteName: platform });
    await this.save(collection);
    return collection.id;
  }

  async delete(id: string): Promise<void> {
    await softDeleteCollection(id);
    await enqueue({ kind: 'collection_delete', entity_id: id });
  }

  /**
   * Update each recipe's `sort_order` to its position in `orderedIds`.
   * Used by the drag-and-drop reorder UI. Only touches the `recipes` row
   * — ingredients and instructions are left alone, so a reorder doesn't
   * trigger a wasteful child-row churn on the server.
   */
  async reorderRecipes(collectionId: string, orderedIds: string[]): Promise<void> {
    const db = await getLocalDb();
    const stamp = now();
    await db.tx(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        const id = orderedIds[i]!;
        await tx.exec(
          `update recipes set sort_order = ?, updated_at = ? where id = ? and collection_id = ?`,
          [i, stamp, id, collectionId],
        );
      }
    });
    for (const id of orderedIds) {
      await enqueue({ kind: 'recipe_reorder', entity_id: id, collection_id: collectionId });
    }
  }
}

export class LocalRecipeRepository implements RecipeRepository {
  constructor(private readonly collectionId: string) {}

  async list(): Promise<Recipe[]> {
    const db = await getLocalDb();
    const rows = await db.execO<RecipeRow>(
      `select * from recipes where collection_id = ? and deleted = 0
       order by sort_order asc`,
      [this.collectionId],
    );
    return hydrateRecipeRowsForCollection(this.collectionId, rows);
  }

  async get(id: string): Promise<Recipe | undefined> {
    const db = await getLocalDb();
    const rows = await db.execO<RecipeRow>(`select * from recipes where id = ? and deleted = 0`, [
      id,
    ]);
    const row = rows[0];
    if (!row) return undefined;
    return hydrateRecipe(row);
  }

  async save(recipe: Recipe): Promise<void> {
    // sort_order pick:
    // - If this id already exists in any collection, preserve its
    //   current sort_order (the matched-existing fold-into-placeholder
    //   flow must keep the placeholder's book-order position).
    // - Otherwise append to the end of the target collection
    //   (max(sort_order) + 1). Hard-coding 0 piled every imported
    //   recipe into the same slot and made freshly-saved recipes hide
    //   among the heap.
    //
    // Folded into one statement so the read and the decision happen in
    // a single SQLite scheduling tick — no chance for a concurrent
    // save in a sibling tab to land between the read and the write
    // and skew the chosen value.
    const db = await getLocalDb();
    const rows = (await db.execO<{ sort_order: number | null }>(
      `select coalesce(
         (select sort_order from recipes where id = ? and deleted = 0),
         (select coalesce(max(sort_order), -1) + 1 from recipes where collection_id = ? and deleted = 0)
       ) as sort_order`,
      [recipe.id, this.collectionId],
    )) as Array<{ sort_order: number | null }>;
    const sortOrder = rows[0]?.sort_order ?? 0;
    await saveLocalRecipe(this.collectionId, recipe, sortOrder);
    await enqueue({
      kind: 'recipe_save',
      entity_id: recipe.id,
      collection_id: this.collectionId,
    });
  }

  async delete(id: string): Promise<void> {
    await softDeleteRecipe(id);
    await enqueue({
      kind: 'recipe_delete',
      entity_id: id,
      collection_id: this.collectionId,
    });
  }
}

// ============================================================
// Cooking tracker repositories
// ============================================================

/** Raw local cooking_events row shape (SQLite types). */
interface CookingEventLocalRow {
  id: string;
  owner_id: string;
  recipe_id: string | null;
  status: string;
  event_date: string;
  occasion_category: string | null;
  meal_slot: string | null;
  occasion_note: string | null;
  notes: string | null;
  adjustments: string;
  recipe_snapshot: string | null;
  photo_paths: string;
  shared_with_household_id: string | null;
  updated_at: number;
  deleted: number;
}

/**
 * A cooking event as the web UI consumes it: the pure domain CookingEvent
 * fields plus the owner + household-share marker needed for attribution
 * ("Alice made this") in a shared household. CookingEventRecord extends
 * CookingEvent so it satisfies the domain CookingEventRepository contract.
 */
export interface CookingEventRecord extends CookingEvent {
  ownerId: string;
  /** Non-null when this row was pulled because a co-member shared their library. */
  sharedWithHouseholdId: string | null;
}

function parseAdjustments(text: string | null): CookingEvent['adjustments'] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as CookingEvent['adjustments']) : [];
  } catch {
    return [];
  }
}

function parseSnapshot(text: string | null): RecipeSnapshot | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as RecipeSnapshot;
  } catch {
    return undefined;
  }
}

function parseStringArray(text: string | null): string[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToCookingEventRecord(row: CookingEventLocalRow): CookingEventRecord {
  return {
    id: row.id,
    recipeId: row.recipe_id,
    status: row.status === 'COOKED' ? 'COOKED' : 'PLANNED',
    eventDate: row.event_date,
    occasionCategory: (row.occasion_category as CookingEvent['occasionCategory']) ?? undefined,
    mealSlot: (row.meal_slot as CookingEvent['mealSlot']) ?? undefined,
    occasionNote: row.occasion_note ?? undefined,
    notes: row.notes ?? undefined,
    adjustments: parseAdjustments(row.adjustments),
    photoPaths: parseStringArray(row.photo_paths),
    recipeSnapshot: parseSnapshot(row.recipe_snapshot),
    ownerId: row.owner_id,
    sharedWithHouseholdId: row.shared_with_household_id,
  };
}

/** A calendar entry: a cooking event enriched with its recipe's title +
 *  collection id (via LEFT JOIN, so both are null once the recipe is
 *  deleted — the snapshot title still renders for COOKED events). */
export interface CalendarEntry extends CookingEventRecord {
  recipeTitle: string | null;
  collectionId: string | null;
}

export class LocalCookingEventRepository implements CookingEventRepository {
  constructor(private readonly ownerId: string) {}

  /** Calendar entries (own + household-shared) in [fromISO, toISO], with
   *  recipe title + collection id joined for linking/display. */
  async listCalendarEntries(fromISO: string, toISO: string): Promise<CalendarEntry[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<
      CookingEventLocalRow & {
        recipe_title: string | null;
        collection_id: string | null;
      }
    >(
      `select ce.*, r.title as recipe_title, r.collection_id as collection_id
         from cooking_events ce
         left join recipes r on r.id = ce.recipe_id and r.deleted = 0
        where ce.deleted = 0
          and (ce.owner_id = ? or ce.shared_with_household_id is not null)
          and ce.event_date >= ? and ce.event_date <= ?
        order by ce.event_date asc, ce.updated_at asc`,
      [this.ownerId, fromISO, toISO],
    )) as Array<
      CookingEventLocalRow & {
        recipe_title: string | null;
        collection_id: string | null;
      }
    >;
    return rows.map((row) => ({
      ...rowToCookingEventRecord(row),
      recipeTitle: row.recipe_title ?? null,
      collectionId: row.collection_id ?? null,
    }));
  }

  /** Distinct free-form occasions previously used (own + shared) — the
   *  vocabulary for the occasion autocomplete, most-recent first. */
  async listOccasions(): Promise<string[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<{ occasion_note: string }>(
      `select occasion_note, max(updated_at) as last_used
         from cooking_events
        where deleted = 0
          and occasion_note is not null and trim(occasion_note) <> ''
          and (owner_id = ? or shared_with_household_id is not null)
        group by occasion_note
        order by last_used desc`,
      [this.ownerId],
    )) as { occasion_note: string }[];
    return rows.map((r) => r.occasion_note);
  }

  /** recipe_id → latest COOKED event_date ('YYYY-MM-DD'), own + household-shared.
   *  Powers the "Recently made" sort; one map serves every list surface. */
  async lastMadeByRecipe(): Promise<Map<string, string>> {
    const db = await getLocalDb();
    const rows = (await db.execO<{ recipe_id: string; last_made: string }>(
      `select recipe_id, max(event_date) as last_made
         from cooking_events
        where deleted = 0 and status = 'COOKED' and recipe_id is not null
          and (owner_id = ? or shared_with_household_id is not null)
        group by recipe_id`,
      [this.ownerId],
    )) as { recipe_id: string; last_made: string }[];
    return new Map(rows.map((r) => [r.recipe_id, r.last_made]));
  }

  /** Past + upcoming events for one recipe (own + household-shared), newest first. */
  async listForRecipe(recipeId: string): Promise<CookingEventRecord[]> {
    const db = await getLocalDb();
    const rows = await db.execO<CookingEventLocalRow>(
      `select * from cooking_events
        where recipe_id = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
        order by event_date desc, updated_at desc`,
      [recipeId, this.ownerId],
    );
    return rows.map(rowToCookingEventRecord);
  }

  /** All events (own + household-shared) whose eventDate is in [fromISO, toISO]. */
  async listInDateRange(fromISO: string, toISO: string): Promise<CookingEventRecord[]> {
    const db = await getLocalDb();
    const rows = await db.execO<CookingEventLocalRow>(
      `select * from cooking_events
        where deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
          and event_date >= ? and event_date <= ?
        order by event_date asc, updated_at asc`,
      [this.ownerId, fromISO, toISO],
    );
    return rows.map(rowToCookingEventRecord);
  }

  async get(id: string): Promise<CookingEventRecord | undefined> {
    const db = await getLocalDb();
    const rows = await db.execO<CookingEventLocalRow>(
      `select * from cooking_events where id = ? and deleted = 0`,
      [id],
    );
    const row = rows[0];
    return row ? rowToCookingEventRecord(row) : undefined;
  }

  async save(event: CookingEvent): Promise<void> {
    await upsertCookingEventRow({
      id: event.id,
      owner_id: this.ownerId,
      recipe_id: event.recipeId,
      status: event.status,
      event_date: event.eventDate,
      occasion_category: event.occasionCategory ?? null,
      meal_slot: event.mealSlot ?? null,
      occasion_note: event.occasionNote ?? null,
      notes: event.notes ?? null,
      adjustments: event.adjustments,
      recipe_snapshot: event.recipeSnapshot ?? null,
      photo_paths: event.photoPaths,
      updated_at: now(),
    });
    await enqueue({ kind: 'cooking_event_save', entity_id: event.id });
  }

  /** PLANNED -> COOKED, capturing the recipe snapshot at cook time. */
  async markCooked(id: string, snapshot: RecipeSnapshot): Promise<void> {
    const db = await getLocalDb();
    await db.exec(
      `update cooking_events
          set status = 'COOKED', recipe_snapshot = ?, updated_at = ?, deleted = 0
        where id = ? and owner_id = ?`,
      [JSON.stringify(snapshot), now(), id, this.ownerId],
    );
    await enqueue({ kind: 'cooking_event_save', entity_id: id });
  }

  async delete(id: string): Promise<void> {
    const db = await getLocalDb();
    await db.exec(
      `update cooking_events set deleted = 1, updated_at = ? where id = ? and owner_id = ?`,
      [now(), id, this.ownerId],
    );
    await enqueue({ kind: 'cooking_event_delete', entity_id: id });
  }
}

/** Raw local recipe_tags row shape. */
interface RecipeTagLocalRow {
  id: string;
  owner_id: string;
  recipe_id: string;
  label: string;
  shared_with_household_id: string | null;
  updated_at: number;
  deleted: number;
}

export class LocalRecipeTagRepository implements RecipeTagRepository {
  constructor(private readonly ownerId: string) {}

  async listForRecipe(recipeId: string): Promise<Tag[]> {
    const db = await getLocalDb();
    const rows = await db.execO<RecipeTagLocalRow>(
      `select * from recipe_tags
        where recipe_id = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
        order by label asc`,
      [recipeId, this.ownerId],
    );
    return rows.map((r) => ({ id: r.id, recipeId: r.recipe_id, label: r.label }));
  }

  async listAllLabels(): Promise<string[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<{ label: string }>(
      `select distinct label from recipe_tags
        where deleted = 0 and (owner_id = ? or shared_with_household_id is not null)
        order by label asc`,
      [this.ownerId],
    )) as { label: string }[];
    return rows.map((r) => r.label);
  }

  async listRecipesByLabel(label: string): Promise<string[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<{ recipe_id: string }>(
      `select distinct recipe_id from recipe_tags
        where label = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)`,
      [normalizeLabel(label), this.ownerId],
    )) as { recipe_id: string }[];
    return rows.map((r) => r.recipe_id);
  }

  /** Idempotent: a no-op if the (owner, recipe, label) tag already exists. */
  async addTag(recipeId: string, label: string): Promise<void> {
    const normalized = normalizeLabel(label);
    if (normalized.length === 0) return;
    const db = await getLocalDb();
    const existing = (await db.execO<{ id: string }>(
      `select id from recipe_tags
        where owner_id = ? and recipe_id = ? and label = ? and deleted = 0
        limit 1`,
      [this.ownerId, recipeId, normalized],
    )) as { id: string }[];
    if (existing.length > 0) return;
    const id = newTagId();
    await upsertRecipeTagRow({
      id,
      owner_id: this.ownerId,
      recipe_id: recipeId,
      label: normalized,
      updated_at: now(),
    });
    await enqueue({ kind: 'recipe_tag_save', entity_id: id });
  }

  /** Hard-delete locally (frees the natural-key slot for re-add) + queue server delete. */
  async removeTag(recipeId: string, label: string): Promise<void> {
    const normalized = normalizeLabel(label);
    const db = await getLocalDb();
    const rows = (await db.execO<{ id: string }>(
      `select id from recipe_tags
        where owner_id = ? and recipe_id = ? and label = ?`,
      [this.ownerId, recipeId, normalized],
    )) as { id: string }[];
    for (const r of rows) {
      await db.exec(`delete from recipe_tags where id = ?`, [r.id]);
      await enqueue({ kind: 'recipe_tag_delete', entity_id: r.id });
    }
  }
}

/** Raw local collection_notes row shape. */
interface CollectionNoteLocalRow {
  id: string;
  collection_id: string | null;
  owner_id: string;
  import_item_id: string | null;
  title: string;
  body: string;
  source_image_text: string | null;
  page_numbers: string;
  sort_order: number;
  shared_with_household_id: string | null;
  updated_at: number;
  deleted: number;
}

/** A CollectionNote plus local ownership attribution so the UI can show a
 *  "shared by household" badge and gate editing to the note's owner. */
export interface CollectionNoteRecord extends CollectionNote {
  ownerId: string;
  sharedWithHouseholdId: string | null;
}

function rowToCollectionNoteRecord(row: CollectionNoteLocalRow): CollectionNoteRecord {
  let pageNumbers: number[] | undefined;
  try {
    const parsed: unknown = JSON.parse(row.page_numbers || '[]');
    if (Array.isArray(parsed)) {
      const nums = parsed.filter((x): x is number => typeof x === 'number');
      if (nums.length > 0) pageNumbers = nums;
    }
  } catch {
    // leave undefined
  }
  return {
    id: row.id,
    collectionId: row.collection_id,
    title: row.title,
    body: row.body,
    pageNumbers,
    sourceImageText: row.source_image_text ?? undefined,
    sortOrder: row.sort_order,
    ownerId: row.owner_id,
    sharedWithHouseholdId: row.shared_with_household_id,
  };
}

export class LocalCollectionNoteRepository implements CollectionNoteRepository {
  constructor(private readonly ownerId: string) {}

  /** Notes filed under one collection — own + household-shared (the household
   *  pull marks co-member rows with shared_with_household_id). */
  async listForCollection(collectionId: string): Promise<CollectionNoteRecord[]> {
    const db = await getLocalDb();
    const rows = await db.execO<CollectionNoteLocalRow>(
      `select * from collection_notes
        where collection_id = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
        order by sort_order asc, updated_at asc`,
      [collectionId, this.ownerId],
    );
    return rows.map(rowToCollectionNoteRecord);
  }

  /** The note filed from a given import page, if any (for the review surface). */
  async getByImportItemId(importItemId: string): Promise<CollectionNoteRecord | undefined> {
    const db = await getLocalDb();
    const rows = await db.execO<CollectionNoteLocalRow>(
      `select * from collection_notes
        where import_item_id = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
        limit 1`,
      [importItemId, this.ownerId],
    );
    return rows[0] ? rowToCollectionNoteRecord(rows[0]) : undefined;
  }

  async save(note: CollectionNote): Promise<void> {
    const db = await getLocalDb();
    // Preserve worker-owned fields (import_item_id / source_image_text /
    // page_numbers) on an edit — the push omits them and they self-heal from
    // the server, but keeping them locally avoids a transient blank window.
    const prevRows = (await db.execO<{
      import_item_id: string | null;
      source_image_text: string | null;
      page_numbers: string;
    }>(
      `select import_item_id, source_image_text, page_numbers from collection_notes where id = ?`,
      [note.id],
    )) as {
      import_item_id: string | null;
      source_image_text: string | null;
      page_numbers: string;
    }[];
    const prev = prevRows[0];
    let pageNumbers: number[] = note.pageNumbers ? [...note.pageNumbers] : [];
    if (!note.pageNumbers && prev) {
      try {
        const parsed: unknown = JSON.parse(prev.page_numbers || '[]');
        if (Array.isArray(parsed))
          pageNumbers = parsed.filter((x): x is number => typeof x === 'number');
      } catch {
        // keep []
      }
    }
    await upsertCollectionNoteRow({
      id: note.id,
      collection_id: note.collectionId,
      owner_id: this.ownerId,
      import_item_id: prev?.import_item_id ?? null,
      title: note.title,
      body: note.body,
      source_image_text: note.sourceImageText ?? prev?.source_image_text ?? null,
      page_numbers: pageNumbers,
      sort_order: note.sortOrder,
      updated_at: now(),
    });
    await enqueue({ kind: 'collection_note_save', entity_id: note.id });
  }

  async delete(id: string): Promise<void> {
    const db = await getLocalDb();
    await db.exec(
      `update collection_notes set deleted = 1, updated_at = ? where id = ? and owner_id = ?`,
      [now(), id, this.ownerId],
    );
    await enqueue({ kind: 'collection_note_delete', entity_id: id });
  }
}

/** Summary of a recently-viewed recipe (local-only analytics). */
export interface RecentlyViewedEntry {
  recipeId: string;
  viewedAt: number;
  recipeTitle: string | null;
  collectionId: string | null;
}

/**
 * LOCAL-ONLY personal browsing history. Never synced, never shared — this
 * is "your own record" and lives only on this device. No outbox, no CRR.
 */
export class LocalRecipeViewRepository {
  async recordView(recipeId: string, source?: string): Promise<void> {
    const db = await getLocalDb();
    await db.exec(`insert into recipe_views (recipe_id, viewed_at, source) values (?,?,?)`, [
      recipeId,
      now(),
      source ?? null,
    ]);
  }

  /** Distinct recipes by most-recent view, newest first. Only surfaces
   *  recipes that still exist locally (a deleted recipe drops out). */
  async listRecentlyViewed(limit = 50): Promise<RecentlyViewedEntry[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<{
      recipe_id: string;
      viewed_at: number;
      recipe_title: string | null;
      collection_id: string | null;
    }>(
      `select v.recipe_id, max(v.viewed_at) as viewed_at,
              r.title as recipe_title, r.collection_id as collection_id
         from recipe_views v
         join recipes r on r.id = v.recipe_id and r.deleted = 0
        group by v.recipe_id
        order by viewed_at desc
        limit ?`,
      [limit],
    )) as Array<{
      recipe_id: string;
      viewed_at: number;
      recipe_title: string | null;
      collection_id: string | null;
    }>;
    return rows.map((r) => ({
      recipeId: r.recipe_id,
      viewedAt: r.viewed_at,
      recipeTitle: r.recipe_title ?? null,
      collectionId: r.collection_id ?? null,
    }));
  }

  async viewCount(recipeId: string): Promise<number> {
    const db = await getLocalDb();
    const rows = (await db.execO<{ c: number }>(
      `select count(*) as c from recipe_views where recipe_id = ?`,
      [recipeId],
    )) as { c: number }[];
    return rows[0]?.c ?? 0;
  }
}

// ------------- helpers -------------

async function hydrateCollection(row: CollectionRow): Promise<RecipeCollection> {
  const db = await getLocalDb();
  // Recipes with at least one ingredient or instruction sort before
  // empty skeletons. Within each group, sort_order is preserved so
  // explicit user reordering still wins. Empty rows usually come from
  // OCR imports that haven't been reviewed yet — keeping them at the
  // bottom of the cookbook keeps the browse view feeling populated.
  const recipeRows = await db.execO<RecipeRow>(
    `select * from recipes
       where collection_id = ? and deleted = 0
       order by has_content desc, sort_order asc`,
    [row.id],
  );
  const recipes = await hydrateRecipeRowsForCollection(row.id, recipeRows);
  return rowToCollection(row, recipes);
}

/**
 * True when this device has no local library content at all. Used by the
 * first-sync overlay to tell a genuine first-ever sync (show "setting up…")
 * from a returning user's per-session initial cycle (don't). Reads the local
 * DB directly so it works during the pre-hydrated window, unlike the
 * hydrated-gated library-summary query.
 */
export async function isLocalLibraryEmpty(): Promise<boolean> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ c: number }>(
    `select (select count(*) from recipe_collections where deleted = 0)
          + (select count(*) from recipes where deleted = 0) as c`,
  )) as { c: number }[];
  return (rows[0]?.c ?? 0) === 0;
}

/**
 * Hydrate recipe rows into domain recipes. Children ride as JSON on each row,
 * so this is a pure in-memory map with no child queries — what used to be a
 * fixed-three-query (formerly N+1) child fetch is now zero queries.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function hydrateRecipeRowsForCollection(
  _collectionId: string,
  recipeRows: RecipeRow[],
): Promise<Recipe[]> {
  // Children ride as JSON on each recipe row — no child queries needed.
  return recipeRows.map(rowToRecipe);
}

// eslint-disable-next-line @typescript-eslint/require-await
async function hydrateRecipe(row: RecipeRow): Promise<Recipe> {
  return rowToRecipe(row);
}

async function saveLocalRecipe(
  collectionId: string,
  recipeIn: Recipe,
  sortOrder: number,
): Promise<void> {
  // Resolve same-collection ingredient cross-reference links BEFORE persisting,
  // so the link rides this recipe's first push (see applyLinksToRecipe).
  const recipe = await applyLinksToRecipe(recipeIn, collectionId);
  const rInsert = recipeToInsert(recipe, collectionId, sortOrder);
  const recipeRow = {
    ...rInsert,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as RecipeRow;
  await upsertRecipeRow(recipeRow);
}

// ------------- Lineage lookups -------------

/** Minimal info about a recipe, enough to render a "based on …" link. */
export interface RecipeSummary {
  id: string;
  title: string;
  collectionId: string;
}

/** Fetch a recipe's title + collection for a given id. Cross-collection. */
export async function getRecipeSummary(id: string): Promise<RecipeSummary | undefined> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ id: string; title: string; collection_id: string }>(
    `select id, title, collection_id from recipes where id = ? and deleted = 0`,
    [id],
  )) as { id: string; title: string; collection_id: string }[];
  const row = rows[0];
  if (!row) return undefined;
  return { id: row.id, title: row.title, collectionId: row.collection_id };
}

/**
 * Resolve ingredient cross-reference targets: for the given recipe ids that
 * still exist locally, their collection + whether they're a placeholder
 * (not-yet-OCR'd). A linked id absent from the result was deleted — the caller
 * renders it as plain text (no dangling tap).
 */
export async function getRecipeLinkTargets(
  ids: readonly string[],
): Promise<Map<string, { collectionId: string; isPlaceholder: boolean }>> {
  const out = new Map<string, { collectionId: string; isPlaceholder: boolean }>();
  if (ids.length === 0) return out;
  const db = await getLocalDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = (await db.execO<{ id: string; collection_id: string; has_content: number }>(
    `select id, collection_id, has_content from recipes where id in (${placeholders}) and deleted = 0`,
    [...ids],
  )) as { id: string; collection_id: string; has_content: number }[];
  for (const r of rows) {
    out.set(r.id, { collectionId: r.collection_id, isPlaceholder: r.has_content !== 1 });
  }
  return out;
}

/** Batched {@link getRecipeSummary}: title + collection for many ids in one query. */
export async function getRecipeSummaries(ids: readonly string[]): Promise<RecipeSummary[]> {
  if (ids.length === 0) return [];
  const db = await getLocalDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = (await db.execO<{ id: string; title: string; collection_id: string }>(
    `select id, title, collection_id from recipes where id in (${placeholders}) and deleted = 0`,
    [...ids],
  )) as { id: string; title: string; collection_id: string }[];
  return rows.map((r) => ({ id: r.id, title: r.title, collectionId: r.collection_id }));
}

export interface RecipeSearchHit {
  recipeId: string;
  recipeTitle: string;
  collectionId: string;
  collectionTitle: string;
  sourceType: CollectionRow['source_type'];
  isPlaceholder: boolean;
}

/**
 * Recipes carrying ANY of the given tag labels (own + household-shared),
 * returned as search hits so the tag-browse grid reuses the same card
 * markup as search/shopping. Labels are normalized to match how they're
 * stored.
 */
export async function searchRecipesByTags(
  ownerId: string,
  labels: readonly string[],
): Promise<RecipeSearchHit[]> {
  const normalized = labels.map((l) => normalizeLabel(l)).filter((l) => l.length > 0);
  if (normalized.length === 0) return [];
  const db = await getLocalDb();
  const placeholders = normalized.map(() => '?').join(',');
  const rows = (await db.execO<{
    id: string;
    title: string;
    collection_id: string;
    collection_title: string;
    source_type: CollectionRow['source_type'];
    has_content: number;
  }>(
    `select distinct r.id, r.title, r.collection_id,
            c.title as collection_title, c.source_type,
            r.has_content
       from recipe_tags t
       join recipes r on r.id = t.recipe_id
       join recipe_collections c on c.id = r.collection_id
      where t.deleted = 0 and r.deleted = 0 and c.deleted = 0
        and (t.owner_id = ? or t.shared_with_household_id is not null)
        and t.label in (${placeholders})
      order by has_content desc, c.title asc, r.sort_order asc`,
    [ownerId, ...normalized],
  )) as Array<{
    id: string;
    title: string;
    collection_id: string;
    collection_title: string;
    source_type: CollectionRow['source_type'];
    has_content: number;
  }>;
  return rows.map((r) => ({
    recipeId: r.id,
    recipeTitle: r.title,
    collectionId: r.collection_id,
    collectionTitle: r.collection_title,
    sourceType: r.source_type,
    isPlaceholder: !r.has_content,
  }));
}

/** Escape LIKE wildcards so a user's query is matched literally (paired
 *  with `escape '\'` in the SQL). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Fully hydrate a specific set of recipes by id, in a fixed number of
 * queries (not per-recipe). Used by the shopping list to hydrate only the
 * recipes the user actually selected, instead of materializing the whole
 * library. Same batch-and-bucket shape as hydrateRecipeRowsForCollection.
 */
export async function getRecipesByIds(ids: readonly string[]): Promise<Recipe[]> {
  if (ids.length === 0) return [];
  const db = await getLocalDb();
  const ph = ids.map(() => '?').join(',');
  const args = ids as string[];
  const recipeRows = await db.execO<RecipeRow>(
    `select * from recipes where id in (${ph}) and deleted = 0`,
    args,
  );
  if (recipeRows.length === 0) return [];
  // Children ride as JSON on the recipe row. Preserve the caller's order.
  const byId = new Map(recipeRows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is RecipeRow => r != null)
    .map(rowToRecipe);
}

/** List direct adaptations of a recipe, regardless of collection. */
export async function listAdaptations(parentId: string): Promise<RecipeSummary[]> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ id: string; title: string; collection_id: string }>(
    `select id, title, collection_id from recipes
     where parent_recipe_id = ? and deleted = 0
     order by title asc`,
    [parentId],
  )) as { id: string; title: string; collection_id: string }[];
  return rows.map((r) => ({ id: r.id, title: r.title, collectionId: r.collection_id }));
}

function tsToMs(ts: string | number | null | undefined): number {
  if (typeof ts === 'number') return ts;
  if (!ts) return now();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : now();
}

// ------------- Recipe embeddings (local mirror) -------------

export interface LocalEmbeddingRow {
  recipeId: string;
  embedding: Float32Array;
  textHash: string;
  model: string;
  updatedAtMs: number;
}

/**
 * Pack a Float32Array into a byte view safe to write as a SQLite BLOB.
 * Endianness: we never round-trip the bytes off-device, so the host's
 * native little-endian layout is fine — both the browser and the
 * sqlite VFS see the same machine.
 */
export function packEmbedding(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Unpack a SQLite BLOB back into a Float32Array. Copies into a fresh
 * buffer so callers don't have to worry about the underlying storage
 * lifetime (cr-sqlite hands us a borrowed view that the VFS may reuse).
 */
export function unpackEmbedding(bytes: Uint8Array): Float32Array {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Float32Array(copy);
}

// Bumped on every local write to `recipe_embeddings`. The search worker
// hydrates the vector matrix once and keeps it; comparing this counter is how
// it notices the mirror moved underneath it and re-hydrates. A plain counter
// rather than a subscription so `local/` keeps no dependency on `search/`.
let embeddingVersion = 0;

/** Current local-embedding generation. See `embeddingVersion`. */
export function getEmbeddingVersion(): number {
  return embeddingVersion;
}

/**
 * Upsert a single embedding row — used by the realtime handler in
 * `sync.ts` and `search/saveHook.ts`. For batch pulls use
 * `upsertLocalEmbeddingsBatch` instead.
 */
export async function upsertLocalEmbedding(row: LocalEmbeddingRow): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into recipe_embeddings (recipe_id, embedding, text_hash, model, updated_at)
     values (?,?,?,?,?)
     on conflict(recipe_id) do update set
       embedding=excluded.embedding,
       text_hash=excluded.text_hash,
       model=excluded.model,
       updated_at=excluded.updated_at
     where excluded.updated_at >= recipe_embeddings.updated_at`,
    [row.recipeId, packEmbedding(row.embedding), row.textHash, row.model, row.updatedAtMs],
  );
  embeddingVersion += 1;
}

export async function upsertLocalEmbeddingsBatch(
  rows: readonly LocalEmbeddingRow[],
): Promise<void> {
  if (rows.length === 0) return;
  // Filter out stale incoming rows first, mirroring the recipes path.
  const db = await getLocalDb();
  const ids = rows.map((r) => r.recipeId);
  const existing = new Map<string, number>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const found = (await db.execO<{ recipe_id: string; updated_at: number }>(
      `select recipe_id, updated_at from recipe_embeddings where recipe_id in (${ph})`,
      slice,
    )) as { recipe_id: string; updated_at: number }[];
    for (const f of found) existing.set(f.recipe_id, f.updated_at);
  }

  const fresh = rows.filter((row) => {
    const local = existing.get(row.recipeId);
    return !local || local <= row.updatedAtMs;
  });
  if (fresh.length === 0) return;

  const cols = ['recipe_id', 'embedding', 'text_hash', 'model', 'updated_at'];
  const tuple = `(${cols.map(() => '?').join(',')})`;
  const rowsPerChunk = Math.max(1, Math.floor(MAX_ROWS_PER_INSERT / cols.length));
  for (let i = 0; i < fresh.length; i += rowsPerChunk) {
    const chunk = fresh.slice(i, i + rowsPerChunk);
    const params: unknown[] = [];
    for (const r of chunk) {
      params.push(r.recipeId, packEmbedding(r.embedding), r.textHash, r.model, r.updatedAtMs);
    }
    await db.exec(
      `insert into recipe_embeddings (${cols.join(',')})
       values ${chunk.map(() => tuple).join(',')}
       on conflict(recipe_id) do update set
         embedding=excluded.embedding,
         text_hash=excluded.text_hash,
         model=excluded.model,
         updated_at=excluded.updated_at
       where excluded.updated_at >= recipe_embeddings.updated_at`,
      params as never[],
    );
  }
  embeddingVersion += 1;
}

/** Drop a single row — used when the canonical Postgres row is deleted. */
export async function deleteLocalEmbedding(recipeId: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(`delete from recipe_embeddings where recipe_id = ?`, [recipeId]);
  embeddingVersion += 1;
}

/**
 * Look up the cached row for a recipe. Returns undefined when the
 * worker / save path hasn't computed one yet.
 */
export async function getLocalEmbedding(recipeId: string): Promise<LocalEmbeddingRow | undefined> {
  const db = await getLocalDb();
  const rows = (await db.execO<{
    recipe_id: string;
    embedding: Uint8Array;
    text_hash: string;
    model: string;
    updated_at: number;
  }>(
    `select recipe_id, embedding, text_hash, model, updated_at
       from recipe_embeddings where recipe_id = ?`,
    [recipeId],
  )) as {
    recipe_id: string;
    embedding: Uint8Array;
    text_hash: string;
    model: string;
    updated_at: number;
  }[];
  const r = rows[0];
  if (!r) return undefined;
  return {
    recipeId: r.recipe_id,
    embedding: unpackEmbedding(r.embedding),
    textHash: r.text_hash,
    model: r.model,
    updatedAtMs: r.updated_at,
  };
}

/** The library's vectors, packed for transfer to the search worker. */
export interface EmbeddingMatrix {
  /** Recipe id per row, parallel to `vectors`. */
  ids: string[];
  /** `ids.length * EMBEDDING_DIM` floats, row-major. */
  vectors: Float32Array;
}

/**
 * Every visible recipe vector as one flat buffer, ready to transfer into the
 * search worker and stay there.
 *
 * Deliberately selects no metadata: titles and collection names go stale, so
 * they're re-read per query for the handful of ids that actually come back
 * (`listSearchHitsByIds`) rather than cached alongside the vectors. Decoding
 * straight into the destination buffer also avoids the per-row Float32Array
 * that `unpackEmbedding` would allocate.
 *
 * Visibility (own + household-shared) matches `searchRecipes`. A stale
 * hydration can only ever contain ids that the per-query metadata lookup then
 * re-filters, so sharing changes can't leak through it.
 */
export async function listEmbeddingVectors(ownerId: string): Promise<EmbeddingMatrix> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ recipe_id: string; embedding: Uint8Array }>(
    `select e.recipe_id, e.embedding
       from recipe_embeddings e
       join recipes r on r.id = e.recipe_id and r.deleted = 0
       join recipe_collections c on c.id = r.collection_id and c.deleted = 0
              and (c.owner_id = ? or c.shared_with_household_id is not null)`,
    [ownerId],
  )) as { recipe_id: string; embedding: Uint8Array }[];

  const stride = EMBEDDING_DIM * 4;
  // Skip anything that isn't the expected width — a model change would
  // otherwise silently misalign every row after it.
  const usable = rows.filter((r) => r.embedding.byteLength === stride);
  const vectors = new Float32Array(usable.length * EMBEDDING_DIM);
  const bytes = new Uint8Array(vectors.buffer);
  const ids = new Array<string>(usable.length);
  for (let i = 0; i < usable.length; i += 1) {
    const row = usable[i]!;
    ids[i] = row.recipe_id;
    bytes.set(row.embedding, i * stride);
  }
  return { ids, vectors };
}

/**
 * Search-hit metadata for a specific set of recipe ids — the top-K the worker
 * returned. Re-applies the same visibility filter as `searchRecipes`, so a
 * recipe deleted or un-shared since the vectors were hydrated simply drops out.
 */
export async function listSearchHitsByIds(
  ownerId: string,
  ids: readonly string[],
): Promise<RecipeSearchHit[]> {
  if (ids.length === 0) return [];
  const db = await getLocalDb();
  const ph = ids.map(() => '?').join(',');
  const rows = (await db.execO<{
    id: string;
    title: string;
    collection_id: string;
    collection_title: string;
    source_type: CollectionRow['source_type'];
    has_content: number;
  }>(
    `select r.id, r.title, r.collection_id,
            c.title as collection_title, c.source_type,
            r.has_content
       from recipes r
       join recipe_collections c on c.id = r.collection_id and c.deleted = 0
              and (c.owner_id = ? or c.shared_with_household_id is not null)
      where r.deleted = 0 and r.id in (${ph})`,
    [ownerId, ...ids] as (string | number)[],
  )) as Array<{
    id: string;
    title: string;
    collection_id: string;
    collection_title: string;
    source_type: CollectionRow['source_type'];
    has_content: number;
  }>;
  return rows.map((r) => ({
    recipeId: r.id,
    recipeTitle: r.title,
    collectionId: r.collection_id,
    collectionTitle: r.collection_title,
    sourceType: r.source_type,
    isPlaceholder: !r.has_content,
  }));
}

/**
 * Cheap count of the locally-mirrored embeddings the semantic search can see
 * (own + household-shared, same visibility as `listEmbeddingVectors`). Used
 * by the search page diagnostics to tell apart "the embedder failed to load"
 * from "no vectors have been pulled/computed locally yet" — the two reasons
 * semantic search silently degrades to literal matches.
 */
export async function countSearchableEmbeddings(ownerId: string): Promise<number> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ n: number }>(
    `select count(*) as n
       from recipe_embeddings e
       join recipes r on r.id = e.recipe_id and r.deleted = 0
       join recipe_collections c on c.id = r.collection_id and c.deleted = 0
              and (c.owner_id = ? or c.shared_with_household_id is not null)`,
    [ownerId],
  )) as { n: number }[];
  return rows[0]?.n ?? 0;
}

// Literal/offline fallback search now lives in the LocalRecipeCollectionRepository
// (`searchRecipes`), which also covers household-shared recipes and "not
// imported" placeholders. The semantic path falls back to it via
// collectionRepo(ownerId).searchRecipes() in apps/web/src/search.
