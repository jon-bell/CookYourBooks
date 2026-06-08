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
import { createWebCollection, newCookingEventId, newTagId, normalizeLabel } from '@cookyourbooks/domain';
import {
  rowToCollection,
  rowsToRecipe,
  collectionToInsert,
  recipeToInsert,
  ingredientToInsert,
  instructionToInsert,
  instructionRefToInsert,
  type CollectionRow,
  type IngredientRow,
  type InstructionRefRow,
  type InstructionRow,
  type RecipeRow,
} from '@cookyourbooks/db';
import { getLocalDb } from './db.js';
import { enqueue } from './outbox.js';
import { shouldSuppressCrrTriggers } from './crrSuppression.js';

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
export async function upsertCollectionsBatch(
  rows: readonly CollectionRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const fresh = await filterFresherIncoming(
    'recipe_collections',
    rows,
    (r) => r.id,
    (r) => tsToMs(r.updated_at),
  );
  if (fresh.length === 0) return;
  await withSuppressedCrrTriggers(['recipe_collections'], fresh.length, async () => {
    await bulkInsertOnConflictId(
      'recipe_collections',
      COLLECTION_COLS,
      fresh,
      collectionToParams,
    );
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
    typeof row.adjustments === 'string'
      ? row.adjustments
      : JSON.stringify(row.adjustments ?? []);
  const snapshot =
    row.recipe_snapshot === null || row.recipe_snapshot === undefined
      ? null
      : typeof row.recipe_snapshot === 'string'
        ? row.recipe_snapshot
        : JSON.stringify(row.recipe_snapshot);
  const photoPaths =
    typeof row.photo_paths === 'string'
      ? row.photo_paths
      : JSON.stringify(row.photo_paths ?? []);
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

/** Upsert a recipe row and replace its child ingredients/instructions + step refs. */
export async function upsertRecipeRow(
  recipeRow: RecipeRow,
  ingredients: IngredientRow[],
  instructions: InstructionRow[],
  refs: InstructionRefRow[] = [],
): Promise<void> {
  const db = await getLocalDb();
  const incomingTs = tsToMs(recipeRow.updated_at);
  // Refuse to regress a fresher local row with a stale pull. Check the
  // existing row's timestamp *before* starting the tx so we don't wipe its
  // child rows only to skip the parent overwrite.
  const existing = (await db.execO<{ updated_at: number }>(
    `select updated_at from recipes where id = ?`,
    [recipeRow.id],
  )) as { updated_at: number }[];
  if (existing[0] && existing[0].updated_at > incomingTs) return;

  await db.tx(async (tx) => {
    const recipeRowX = recipeRow as RecipeRow & {
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
    };
    // Array-ish columns live as TEXT (JSON) in SQLite; the Postgres
    // mirror uses jsonb. Accept either shape on input.
    const equipmentJson = toJsonText(recipeRowX.equipment);
    const pageNumbersJson = toJsonText(recipeRowX.page_numbers);
    const starredRaw: unknown = recipeRowX.starred;
    const starredInt = starredRaw === true || starredRaw === 1 ? 1 : 0;
    await tx.exec(
      `insert into recipes
         (id, collection_id, title, servings_amount, servings_description,
          servings_amount_max, sort_order, notes, parent_recipe_id,
          description, time_estimate, equipment, book_title, page_numbers,
          source_image_text, source_url, starred, updated_at, deleted)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
       on conflict(id) do update set
         collection_id=excluded.collection_id,
         title=excluded.title,
         servings_amount=excluded.servings_amount,
         servings_description=excluded.servings_description,
         servings_amount_max=excluded.servings_amount_max,
         sort_order=excluded.sort_order,
         notes=excluded.notes,
         parent_recipe_id=excluded.parent_recipe_id,
         description=excluded.description,
         time_estimate=excluded.time_estimate,
         equipment=excluded.equipment,
         book_title=excluded.book_title,
         page_numbers=excluded.page_numbers,
         source_image_text=excluded.source_image_text,
         source_url=excluded.source_url,
         starred=excluded.starred,
         updated_at=excluded.updated_at,
         deleted=0`,
      [
        recipeRow.id,
        recipeRow.collection_id,
        recipeRow.title,
        recipeRow.servings_amount,
        recipeRow.servings_description,
        recipeRowX.servings_amount_max ?? null,
        recipeRow.sort_order,
        recipeRowX.notes ?? null,
        recipeRowX.parent_recipe_id ?? null,
        recipeRowX.description ?? null,
        recipeRowX.time_estimate ?? null,
        equipmentJson,
        recipeRowX.book_title ?? null,
        pageNumbersJson,
        recipeRowX.source_image_text ?? null,
        recipeRowX.source_url ?? null,
        starredInt,
        incomingTs,
      ],
    );
    // Wipe child rows before re-inserting. Refs are identified by their
    // instruction_id, so a blanket `in (select id from instructions
    // where recipe_id = ?)` works before we drop the instructions
    // themselves.
    await tx.exec(
      `delete from instruction_ingredient_refs
       where instruction_id in (select id from instructions where recipe_id = ?)`,
      [recipeRow.id],
    );
    await tx.exec(`delete from ingredients where recipe_id = ?`, [recipeRow.id]);
    await tx.exec(`delete from instructions where recipe_id = ?`, [recipeRow.id]);
    for (const ing of ingredients) {
      const ingX = ing as IngredientRow & { description?: string | null };
      await tx.exec(
        `insert into ingredients
           (id, recipe_id, sort_order, type, name, preparation, notes, description,
            quantity_type, quantity_amount, quantity_whole, quantity_numerator,
            quantity_denominator, quantity_min, quantity_max, quantity_unit)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          ing.id,
          ing.recipe_id,
          ing.sort_order,
          ing.type,
          ing.name,
          ing.preparation,
          ing.notes,
          ingX.description ?? null,
          ing.quantity_type,
          ing.quantity_amount,
          ing.quantity_whole,
          ing.quantity_numerator,
          ing.quantity_denominator,
          ing.quantity_min,
          ing.quantity_max,
          ing.quantity_unit,
        ],
      );
    }
    for (const step of instructions) {
      const stepX = step as InstructionRow & {
        temperature_value?: number | null;
        temperature_unit?: string | null;
        sub_instructions?: unknown;
        simplified_steps?: unknown;
        notes?: string | null;
      };
      await tx.exec(
        `insert into instructions
           (id, recipe_id, step_number, text,
            temperature_value, temperature_unit, sub_instructions,
            simplified_steps, notes)
         values (?,?,?,?,?,?,?,?,?)`,
        [
          step.id,
          step.recipe_id,
          step.step_number,
          step.text,
          stepX.temperature_value ?? null,
          stepX.temperature_unit ?? null,
          toJsonText(stepX.sub_instructions),
          toJsonText(stepX.simplified_steps),
          stepX.notes ?? null,
        ],
      );
    }
    for (const ref of refs) {
      const refX = ref as InstructionRefRow & {
        consumed_quantity_type?: string | null;
        consumed_quantity_amount?: number | null;
        consumed_quantity_whole?: number | null;
        consumed_quantity_numerator?: number | null;
        consumed_quantity_denominator?: number | null;
        consumed_quantity_min?: number | null;
        consumed_quantity_max?: number | null;
        consumed_quantity_unit?: string | null;
      };
      await tx.exec(
        `insert into instruction_ingredient_refs
           (instruction_id, ingredient_id,
            consumed_quantity_type, consumed_quantity_amount,
            consumed_quantity_whole, consumed_quantity_numerator,
            consumed_quantity_denominator, consumed_quantity_min,
            consumed_quantity_max, consumed_quantity_unit)
         values (?,?,?,?,?,?,?,?,?,?) on conflict do nothing`,
        [
          ref.instruction_id,
          ref.ingredient_id,
          refX.consumed_quantity_type ?? null,
          refX.consumed_quantity_amount ?? null,
          refX.consumed_quantity_whole ?? null,
          refX.consumed_quantity_numerator ?? null,
          refX.consumed_quantity_denominator ?? null,
          refX.consumed_quantity_min ?? null,
          refX.consumed_quantity_max ?? null,
          refX.consumed_quantity_unit ?? null,
        ],
      );
    }
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
export const PULL_CRR_TABLES = [
  'instruction_ingredient_refs',
  'instructions',
  'ingredients',
  'recipes',
] as const;

/**
 * Run `fn` with cr-sqlite's per-row change-tracking triggers suspended
 * on `tables`. cr-sqlite's crsql_begin_alter / crsql_commit_alter pair
 * drops the row triggers for the duration and recreates them on
 * commit_alter — exactly the property a *bulk* pull needs, since pulled
 * rows are server-canonical and don't need to be re-propagated as
 * outbound CRDT changes.
 *
 * `rowCount` is the number of rows `fn` is about to write. Below
 * {@link CRR_SUPPRESS_MIN_ROWS} we skip the begin/commit_alter dance and
 * just run `fn` with triggers live — paying a handful of cheap per-row
 * trigger fires instead of one table-sized commit_alter (see
 * {@link shouldSuppressCrrTriggers}). Pass the total row count across all
 * `tables` (e.g. recipes + ingredients + instructions + refs), since
 * that's what the trigger cost tracks.
 *
 * Must run at the top level (not inside a SAVEPOINT / db.tx callback) so
 * the triggers re-attach cleanly even on caller failure.
 */
export async function withSuppressedCrrTriggers<T>(
  tables: readonly string[],
  rowCount: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!shouldSuppressCrrTriggers(rowCount)) {
    return await fn();
  }
  const db = await getLocalDb();
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
    const found = (await db.execO(
      `select id, updated_at from ${table} where id in (${placeholders})`,
      ids,
    )) as { id: string; updated_at: number }[];
    for (const r of found) existingMap.set(r.id, r.updated_at);
  }
  return rows.filter((row) => {
    const local = existingMap.get(idOf(row));
    return !local || local <= incomingTsMs(row);
  });
}

export type RecipeBatchEntry = {
  recipe: RecipeRow;
  ingredients: IngredientRow[];
  instructions: InstructionRow[];
  refs: InstructionRefRow[];
};

/** Total rows a recipe batch writes — a recipe drags in its children. */
export function recipeBatchRowCount(batch: ReadonlyArray<RecipeBatchEntry>): number {
  return batch.reduce(
    (acc, b) => acc + 1 + b.ingredients.length + b.instructions.length + b.refs.length,
    0,
  );
}

/**
 * Upsert one recipe chunk in a single tx, assuming the caller already holds
 * the CRR-trigger suppression. Use this when draining a large pull in
 * checkpointed chunks under ONE {@link withSuppressedCrrTriggers} boundary:
 * `crsql_commit_alter` is O(table size), so suppressing per-chunk pays that
 * full-table cost once per chunk (64 × O(16k) wedged a large library's pull
 * past the 45s watchdog). Hoisting the boundary to wrap the whole loop makes
 * it run exactly once regardless of library size. Callers writing a small
 * one-off batch (realtime echoes) should use {@link upsertRecipesBatch},
 * which manages the boundary itself.
 */
export async function upsertRecipesBatchInner(
  batch: ReadonlyArray<RecipeBatchEntry>,
  signal?: AbortSignal,
): Promise<void> {
  if (batch.length === 0) return;
  if (signal?.aborted) return;
  const db = await getLocalDb();
  await db.tx(async (tx) => {
    const ids = batch.map((b) => b.recipe.id);
    const existingMap = new Map<string, number>();
    const placeholders = ids.map(() => '?').join(',');
    const rows = (await tx.execO(
      `select id, updated_at from recipes where id in (${placeholders})`,
      ids,
    )) as { id: string; updated_at: number }[];
    for (const r of rows) existingMap.set(r.id, r.updated_at);

    const fresh = batch.filter((b) => {
      const local = existingMap.get(b.recipe.id);
      return !local || local <= tsToMs(b.recipe.updated_at);
    });
    if (fresh.length === 0) return;

    const freshIds = fresh.map((b) => b.recipe.id);
    await execInChunks(tx, freshIds, (chunk, ph) => [
      `delete from instruction_ingredient_refs
       where instruction_id in (select id from instructions where recipe_id in (${ph}))`,
      chunk,
    ]);
    await execInChunks(tx, freshIds, (chunk, ph) => [
      `delete from ingredients where recipe_id in (${ph})`,
      chunk,
    ]);
    await execInChunks(tx, freshIds, (chunk, ph) => [
      `delete from instructions where recipe_id in (${ph})`,
      chunk,
    ]);

    await bulkUpsertRecipes(tx, fresh.map((b) => b.recipe));
    await bulkInsertIngredients(tx, fresh.flatMap((b) => b.ingredients));
    await bulkInsertInstructions(tx, fresh.flatMap((b) => b.instructions));
    await bulkInsertRefs(tx, fresh.flatMap((b) => b.refs));
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
// table (recipes, 19 cols), 1500 rows × 19 cols = 28500 params, safely
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

async function execInChunks(
  tx: RecipeTx,
  ids: readonly string[],
  build: (chunk: string[], placeholders: string) => [string, unknown[]],
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');
    const [sql, bind] = build(chunk, ph);
    await tx.exec(sql, bind);
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
      };
      const starredRaw: unknown = rx.starred;
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

async function bulkInsertIngredients(
  tx: RecipeTx,
  ingredients: readonly IngredientRow[],
): Promise<void> {
  if (ingredients.length === 0) return;
  const cols = [
    'id',
    'recipe_id',
    'sort_order',
    'type',
    'name',
    'preparation',
    'notes',
    'description',
    'quantity_type',
    'quantity_amount',
    'quantity_whole',
    'quantity_numerator',
    'quantity_denominator',
    'quantity_min',
    'quantity_max',
    'quantity_unit',
  ];
  const tuple = `(${cols.map(() => '?').join(',')})`;
  for (let i = 0; i < ingredients.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = ingredients.slice(i, i + MAX_ROWS_PER_INSERT);
    const params: unknown[] = [];
    for (const ing of chunk) {
      const ingX = ing as IngredientRow & { description?: string | null };
      params.push(
        ing.id,
        ing.recipe_id,
        ing.sort_order,
        ing.type,
        ing.name,
        ing.preparation,
        ing.notes,
        ingX.description ?? null,
        ing.quantity_type,
        ing.quantity_amount,
        ing.quantity_whole,
        ing.quantity_numerator,
        ing.quantity_denominator,
        ing.quantity_min,
        ing.quantity_max,
        ing.quantity_unit,
      );
    }
    await tx.exec(
      `insert into ingredients (${cols.join(',')}) values ${chunk.map(() => tuple).join(',')}`,
      params,
    );
  }
}

async function bulkInsertInstructions(
  tx: RecipeTx,
  steps: readonly InstructionRow[],
): Promise<void> {
  if (steps.length === 0) return;
  const cols = [
    'id',
    'recipe_id',
    'step_number',
    'text',
    'temperature_value',
    'temperature_unit',
    'sub_instructions',
    'simplified_steps',
    'notes',
  ];
  const tuple = `(${cols.map(() => '?').join(',')})`;
  for (let i = 0; i < steps.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = steps.slice(i, i + MAX_ROWS_PER_INSERT);
    const params: unknown[] = [];
    for (const step of chunk) {
      const sx = step as InstructionRow & {
        temperature_value?: number | null;
        temperature_unit?: string | null;
        sub_instructions?: unknown;
        simplified_steps?: unknown;
        notes?: string | null;
      };
      params.push(
        step.id,
        step.recipe_id,
        step.step_number,
        step.text,
        sx.temperature_value ?? null,
        sx.temperature_unit ?? null,
        toJsonText(sx.sub_instructions),
        toJsonText(sx.simplified_steps),
        sx.notes ?? null,
      );
    }
    await tx.exec(
      `insert into instructions (${cols.join(',')}) values ${chunk.map(() => tuple).join(',')}`,
      params,
    );
  }
}

async function bulkInsertRefs(
  tx: RecipeTx,
  refs: readonly InstructionRefRow[],
): Promise<void> {
  if (refs.length === 0) return;
  const cols = [
    'instruction_id',
    'ingredient_id',
    'consumed_quantity_type',
    'consumed_quantity_amount',
    'consumed_quantity_whole',
    'consumed_quantity_numerator',
    'consumed_quantity_denominator',
    'consumed_quantity_min',
    'consumed_quantity_max',
    'consumed_quantity_unit',
  ];
  const tuple = `(${cols.map(() => '?').join(',')})`;
  for (let i = 0; i < refs.length; i += MAX_ROWS_PER_INSERT) {
    const chunk = refs.slice(i, i + MAX_ROWS_PER_INSERT);
    const params: unknown[] = [];
    for (const ref of chunk) {
      const rx = ref as InstructionRefRow & {
        consumed_quantity_type?: string | null;
        consumed_quantity_amount?: number | null;
        consumed_quantity_whole?: number | null;
        consumed_quantity_numerator?: number | null;
        consumed_quantity_denominator?: number | null;
        consumed_quantity_min?: number | null;
        consumed_quantity_max?: number | null;
        consumed_quantity_unit?: string | null;
      };
      params.push(
        ref.instruction_id,
        ref.ingredient_id,
        rx.consumed_quantity_type ?? null,
        rx.consumed_quantity_amount ?? null,
        rx.consumed_quantity_whole ?? null,
        rx.consumed_quantity_numerator ?? null,
        rx.consumed_quantity_denominator ?? null,
        rx.consumed_quantity_min ?? null,
        rx.consumed_quantity_max ?? null,
        rx.consumed_quantity_unit ?? null,
      );
    }
    await tx.exec(
      `insert into instruction_ingredient_refs (${cols.join(',')}) values ${chunk
        .map(() => tuple)
        .join(',')} on conflict do nothing`,
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

export async function softDeleteCollection(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `update recipe_collections set deleted = 1, updated_at = ? where id = ?`,
    [now(), id],
  );
}

export async function softDeleteRecipe(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `update recipes set deleted = 1, updated_at = ? where id = ?`,
    [now(), id],
  );
}

export async function purgeCollection(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.tx(async (tx) => {
    const recipeIds = (await tx.execO<{ id: string }>(
      `select id from recipes where collection_id = ?`,
      [id],
    )) as { id: string }[];
    for (const r of recipeIds) {
      await tx.exec(
        `delete from instruction_ingredient_refs
         where instruction_id in (select id from instructions where recipe_id = ?)`,
        [r.id],
      );
      await tx.exec(`delete from ingredients where recipe_id = ?`, [r.id]);
      await tx.exec(`delete from instructions where recipe_id = ?`, [r.id]);
    }
    await tx.exec(`delete from recipes where collection_id = ?`, [id]);
    await tx.exec(`delete from recipe_collections where id = ?`, [id]);
  });
}

export async function purgeRecipe(id: string): Promise<void> {
  const db = await getLocalDb();
  await db.tx(async (tx) => {
    await tx.exec(
      `delete from instruction_ingredient_refs
       where instruction_id in (select id from instructions where recipe_id = ?)`,
      [id],
    );
    await tx.exec(`delete from ingredients where recipe_id = ?`, [id]);
    await tx.exec(`delete from instructions where recipe_id = ?`, [id]);
    await tx.exec(`delete from recipes where id = ?`, [id]);
  });
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
             where r.deleted = 0
               and (exists (select 1 from ingredients where recipe_id = r.id)
                    or exists (select 1 from instructions where recipe_id = r.id))
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
    }>(
      `select c.id, c.title, c.cover_image_path, c.is_public, c.source_type,
              c.author, c.site_name,
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
           where r.deleted = 0
             and (exists (select 1 from ingredients where recipe_id = r.id)
                  or exists (select 1 from instructions where recipe_id = r.id))
           group by r.collection_id
       ) fc on fc.collection_id = c.id
       where (c.owner_id = ? or c.shared_with_household_id is not null)
         and c.deleted = 0
       order by (filled_count > 0) desc, coalesce(c.updated_at, 0) desc`,
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
    }));
  }

  async list(): Promise<RecipeCollection[]> {
    const db = await getLocalDb();
    // Includes household-shared collections from other members; pullAll
    // only places visible-to-me collections in local SQLite so a simple
    // OR is sufficient.
    const colRows = (await db.execO<CollectionRow>(
      `select * from recipe_collections
       where (owner_id = ? or shared_with_household_id is not null) and deleted = 0
       order by coalesce(updated_at, 0) desc`,
      [this.ownerId],
    )) as CollectionRow[];
    return Promise.all(colRows.map((row) => hydrateCollection(row)));
  }

  async get(id: string): Promise<RecipeCollection | undefined> {
    const db = await getLocalDb();
    const rows = (await db.execO<CollectionRow>(
      `select * from recipe_collections where id = ? and deleted = 0`,
      [id],
    )) as CollectionRow[];
    const row = rows[0];
    if (!row) return undefined;
    return hydrateCollection(row);
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
   */
  async searchRecipes(query: string): Promise<RecipeSearchHit[]> {
    const db = await getLocalDb();
    const q = query.trim().toLowerCase();
    const params: unknown[] = [this.ownerId];
    let filter = '';
    if (q) {
      const like = `%${escapeLike(q)}%`;
      filter = ` and (lower(r.title) like ? escape '\\'
                 or exists (select 1 from ingredients i
                            where i.recipe_id = r.id and lower(i.name) like ? escape '\\'))`;
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
              (exists (select 1 from ingredients where recipe_id = r.id)
               or exists (select 1 from instructions where recipe_id = r.id)) as has_content
         from recipes r
         join recipe_collections c on c.id = r.collection_id
        where r.deleted = 0 and c.deleted = 0
          and (c.owner_id = ? or c.shared_with_household_id is not null)
          ${filter}
        order by has_content desc, c.title asc, r.sort_order asc`,
      params as (string | number)[],
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
    const rows = (await db.execO<RecipeRow>(
      `select * from recipes where collection_id = ? and deleted = 0
       order by sort_order asc`,
      [this.collectionId],
    )) as RecipeRow[];
    return hydrateRecipeRowsForCollection(this.collectionId, rows);
  }

  async get(id: string): Promise<Recipe | undefined> {
    const db = await getLocalDb();
    const rows = (await db.execO<RecipeRow>(
      `select * from recipes where id = ? and deleted = 0`,
      [id],
    )) as RecipeRow[];
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
    occasionCategory:
      (row.occasion_category as CookingEvent['occasionCategory']) ?? undefined,
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
    const rows = (await db.execO<CookingEventLocalRow & {
      recipe_title: string | null;
      collection_id: string | null;
    }>(
      `select ce.*, r.title as recipe_title, r.collection_id as collection_id
         from cooking_events ce
         left join recipes r on r.id = ce.recipe_id and r.deleted = 0
        where ce.deleted = 0
          and (ce.owner_id = ? or ce.shared_with_household_id is not null)
          and ce.event_date >= ? and ce.event_date <= ?
        order by ce.event_date asc, ce.updated_at asc`,
      [this.ownerId, fromISO, toISO],
    )) as Array<CookingEventLocalRow & {
      recipe_title: string | null;
      collection_id: string | null;
    }>;
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

  /** Past + upcoming events for one recipe (own + household-shared), newest first. */
  async listForRecipe(recipeId: string): Promise<CookingEventRecord[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<CookingEventLocalRow>(
      `select * from cooking_events
        where recipe_id = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
        order by event_date desc, updated_at desc`,
      [recipeId, this.ownerId],
    )) as CookingEventLocalRow[];
    return rows.map(rowToCookingEventRecord);
  }

  /** All events (own + household-shared) whose eventDate is in [fromISO, toISO]. */
  async listInDateRange(fromISO: string, toISO: string): Promise<CookingEventRecord[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<CookingEventLocalRow>(
      `select * from cooking_events
        where deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
          and event_date >= ? and event_date <= ?
        order by event_date asc, updated_at asc`,
      [this.ownerId, fromISO, toISO],
    )) as CookingEventLocalRow[];
    return rows.map(rowToCookingEventRecord);
  }

  async get(id: string): Promise<CookingEventRecord | undefined> {
    const db = await getLocalDb();
    const rows = (await db.execO<CookingEventLocalRow>(
      `select * from cooking_events where id = ? and deleted = 0`,
      [id],
    )) as CookingEventLocalRow[];
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
    const rows = (await db.execO<RecipeTagLocalRow>(
      `select * from recipe_tags
        where recipe_id = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
        order by label asc`,
      [recipeId, this.ownerId],
    )) as RecipeTagLocalRow[];
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
    const parsed = JSON.parse(row.page_numbers || '[]');
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
    const rows = (await db.execO<CollectionNoteLocalRow>(
      `select * from collection_notes
        where collection_id = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
        order by sort_order asc, updated_at asc`,
      [collectionId, this.ownerId],
    )) as CollectionNoteLocalRow[];
    return rows.map(rowToCollectionNoteRecord);
  }

  /** The note filed from a given import page, if any (for the review surface). */
  async getByImportItemId(importItemId: string): Promise<CollectionNoteRecord | undefined> {
    const db = await getLocalDb();
    const rows = (await db.execO<CollectionNoteLocalRow>(
      `select * from collection_notes
        where import_item_id = ? and deleted = 0
          and (owner_id = ? or shared_with_household_id is not null)
        limit 1`,
      [importItemId, this.ownerId],
    )) as CollectionNoteLocalRow[];
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
    )) as { import_item_id: string | null; source_image_text: string | null; page_numbers: string }[];
    const prev = prevRows[0];
    let pageNumbers: number[] = note.pageNumbers ? [...note.pageNumbers] : [];
    if (!note.pageNumbers && prev) {
      try {
        const parsed = JSON.parse(prev.page_numbers || '[]');
        if (Array.isArray(parsed)) pageNumbers = parsed.filter((x): x is number => typeof x === 'number');
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
    await db.exec(
      `insert into recipe_views (recipe_id, viewed_at, source) values (?,?,?)`,
      [recipeId, now(), source ?? null],
    );
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
  const recipeRows = (await db.execO<RecipeRow>(
    `select * from recipes
       where collection_id = ? and deleted = 0
       order by
         case when exists (select 1 from ingredients where recipe_id = recipes.id)
                or exists (select 1 from instructions where recipe_id = recipes.id)
              then 0 else 1 end asc,
         sort_order asc`,
    [row.id],
  )) as RecipeRow[];
  const recipes = await hydrateRecipeRowsForCollection(row.id, recipeRows);
  return rowToCollection(row, recipes);
}

/**
 * Hydrate every recipe in a collection with a *fixed* number of child
 * queries (three) instead of three-per-recipe.
 *
 * `hydrateRecipe` issues one ingredients + one instructions + one refs
 * query per recipe. Looping it (the old `recipeRows.map(hydrateRecipe)`)
 * was a textbook N+1: a 100-recipe cookbook fired ~300 reads that all
 * serialize on the single cr-sqlite connection. When a cookbook grew —
 * e.g. after approving a Table-of-Contents import that mints dozens of
 * placeholder recipes — that read storm starved the outbox push's own
 * small reads/writes, so each `recipe_save` ballooned to many seconds
 * even for empty placeholders and the push cycle kept timing out.
 *
 * Here we fetch all children for the collection in three queries, scoped
 * by `recipe_id in (select id from recipes where collection_id = ?)` so
 * the reads ride the collection index rather than a giant IN-list, then
 * group in JS. `rowsToRecipe` already sorts ingredients by sort_order and
 * instructions by step_number, so no ORDER BY is needed here.
 */
async function hydrateRecipeRowsForCollection(
  collectionId: string,
  recipeRows: RecipeRow[],
): Promise<Recipe[]> {
  if (recipeRows.length === 0) return [];
  const db = await getLocalDb();
  const inCollection = `recipe_id in (select id from recipes where collection_id = ? and deleted = 0)`;
  const [ingredients, instructions, refs] = await Promise.all([
    db.execO<IngredientRow>(`select * from ingredients where ${inCollection}`, [collectionId]),
    db.execO<InstructionRow>(`select * from instructions where ${inCollection}`, [collectionId]),
    // refs carry no recipe_id of their own — surface the parent recipe via
    // the join so we can bucket them without a per-recipe query.
    db.execO<InstructionRefRow & { recipe_id: string }>(
      `select r.*, i.recipe_id
         from instruction_ingredient_refs r
         join instructions i on i.id = r.instruction_id
         where i.${inCollection}`,
      [collectionId],
    ),
  ]);
  const bucket = <T extends { recipe_id: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.recipe_id);
      if (list) list.push(r);
      else m.set(r.recipe_id, [r]);
    }
    return m;
  };
  const ingByRecipe = bucket(ingredients as Array<IngredientRow & { recipe_id: string }>);
  const insByRecipe = bucket(instructions as Array<InstructionRow & { recipe_id: string }>);
  const refsByRecipe = bucket(refs as Array<InstructionRefRow & { recipe_id: string }>);
  return recipeRows.map((row) =>
    rowsToRecipe(
      row,
      (ingByRecipe.get(row.id) ?? []) as IngredientRow[],
      (insByRecipe.get(row.id) ?? []) as InstructionRow[],
      (refsByRecipe.get(row.id) ?? []) as InstructionRefRow[],
    ),
  );
}

async function hydrateRecipe(row: RecipeRow): Promise<Recipe> {
  const db = await getLocalDb();
  const [ingredients, instructions, refs] = await Promise.all([
    db.execO<IngredientRow>(`select * from ingredients where recipe_id = ? order by sort_order asc`, [
      row.id,
    ]),
    db.execO<InstructionRow>(
      `select * from instructions where recipe_id = ? order by step_number asc`,
      [row.id],
    ),
    db.execO<InstructionRefRow>(
      `select r.*
       from instruction_ingredient_refs r
       join instructions i on i.id = r.instruction_id
       where i.recipe_id = ?`,
      [row.id],
    ),
  ]);
  return rowsToRecipe(
    row,
    ingredients as IngredientRow[],
    instructions as InstructionRow[],
    refs as InstructionRefRow[],
  );
}

async function saveLocalRecipe(
  collectionId: string,
  recipe: Recipe,
  sortOrder: number,
): Promise<void> {
  const rInsert = recipeToInsert(recipe, collectionId, sortOrder);
  const recipeRow = {
    ...rInsert,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as RecipeRow;
  const ingRows: IngredientRow[] = recipe.ingredients.map((ing, i) => {
    const ins = ingredientToInsert(ing, recipe.id, i);
    return { ...ins, id: ins.id! } as IngredientRow;
  });
  const stepRows: InstructionRow[] = recipe.instructions.map((s) => {
    const ins = instructionToInsert(s, recipe.id);
    return { ...ins, id: ins.id! } as InstructionRow;
  });
  const refRows: InstructionRefRow[] = recipe.instructions.flatMap((s) =>
    s.ingredientRefs.map((r) =>
      instructionRefToInsert(s.id, r.ingredientId, r.quantity) as InstructionRefRow,
    ),
  );
  await upsertRecipeRow(recipeRow, ingRows, stepRows, refRows);
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
            (exists (select 1 from ingredients where recipe_id = r.id)
             or exists (select 1 from instructions where recipe_id = r.id)) as has_content
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
  const args = ids as readonly string[] as string[];
  const recipeRows = (await db.execO<RecipeRow>(
    `select * from recipes where id in (${ph}) and deleted = 0`,
    args,
  )) as RecipeRow[];
  if (recipeRows.length === 0) return [];
  const inIds = `recipe_id in (${ph})`;
  const [ingredients, instructions, refs] = await Promise.all([
    db.execO<IngredientRow>(`select * from ingredients where ${inIds}`, args),
    db.execO<InstructionRow>(`select * from instructions where ${inIds}`, args),
    db.execO<InstructionRefRow & { recipe_id: string }>(
      `select r.*, i.recipe_id
         from instruction_ingredient_refs r
         join instructions i on i.id = r.instruction_id
         where i.${inIds}`,
      args,
    ),
  ]);
  const bucket = <T extends { recipe_id: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.recipe_id);
      if (list) list.push(r);
      else m.set(r.recipe_id, [r]);
    }
    return m;
  };
  const ingByRecipe = bucket(ingredients as Array<IngredientRow & { recipe_id: string }>);
  const insByRecipe = bucket(instructions as Array<InstructionRow & { recipe_id: string }>);
  const refsByRecipe = bucket(refs as Array<InstructionRefRow & { recipe_id: string }>);
  // Preserve the caller's requested order.
  const byId = new Map(recipeRows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is RecipeRow => r != null)
    .map((row) =>
      rowsToRecipe(
        row,
        (ingByRecipe.get(row.id) ?? []) as IngredientRow[],
        (insByRecipe.get(row.id) ?? []) as InstructionRow[],
        (refsByRecipe.get(row.id) ?? []) as InstructionRefRow[],
      ),
    );
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
    [
      row.recipeId,
      packEmbedding(row.embedding),
      row.textHash,
      row.model,
      row.updatedAtMs,
    ],
  );
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
  for (const row of rows) {
    const local = existing.get(row.recipeId);
    if (local && local > row.updatedAtMs) continue;
    await upsertLocalEmbedding(row);
  }
}

/** Drop a single row — used when the canonical Postgres row is deleted. */
export async function deleteLocalEmbedding(recipeId: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(`delete from recipe_embeddings where recipe_id = ?`, [recipeId]);
}

/**
 * Look up the cached row for a recipe. Returns undefined when the
 * worker / save path hasn't computed one yet.
 */
export async function getLocalEmbedding(
  recipeId: string,
): Promise<LocalEmbeddingRow | undefined> {
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

/**
 * Walk every embedding the caller is allowed to search — joined to
 * recipes + recipe_collections so we can filter soft-deletes and (when
 * an owner id is supplied) restrict to that owner's library. Returns
 * lightweight rows: title + collection metadata enough to render a
 * result row without recipe hydration.
 */
export interface SearchableEmbedding {
  recipeId: string;
  recipeTitle: string;
  collectionId: string;
  collectionTitle: string;
  sourceType: string;
  /** True for a content-less placeholder (global-ToC entry not yet imported);
   *  rendered with a "Not imported" badge, same as the literal search. */
  isPlaceholder: boolean;
  embedding: Float32Array;
}

export async function listSearchableEmbeddings(
  ownerId: string,
): Promise<SearchableEmbedding[]> {
  const db = await getLocalDb();
  // Own recipes + household-shared ones. Co-members' embeddings are pulled
  // into the local mirror by pullHouseholdSharedContent (the recipe_embeddings
  // claim-based RLS grants household reads, 20260624000000), and their
  // collections carry the local-only `shared_with_household_id` marker — same
  // visibility rule the literal searchRecipes uses.
  const rows = (await db.execO<{
    recipe_id: string;
    collection_id: string;
    collection_title: string;
    source_type: string;
    title: string;
    has_content: number;
    embedding: Uint8Array;
  }>(
    `select e.recipe_id, e.embedding, r.collection_id, r.title,
            c.title as collection_title, c.source_type,
            (exists (select 1 from ingredients where recipe_id = r.id)
             or exists (select 1 from instructions where recipe_id = r.id)) as has_content
       from recipe_embeddings e
       join recipes r on r.id = e.recipe_id and r.deleted = 0
       join recipe_collections c on c.id = r.collection_id and c.deleted = 0
              and (c.owner_id = ? or c.shared_with_household_id is not null)`,
    [ownerId],
  )) as {
    recipe_id: string;
    collection_id: string;
    collection_title: string;
    source_type: string;
    title: string;
    has_content: number;
    embedding: Uint8Array;
  }[];
  return rows.map((r) => ({
    recipeId: r.recipe_id,
    recipeTitle: r.title,
    collectionId: r.collection_id,
    collectionTitle: r.collection_title,
    sourceType: r.source_type,
    isPlaceholder: !r.has_content,
    embedding: unpackEmbedding(r.embedding),
  }));
}

// Literal/offline fallback search now lives in the LocalRecipeCollectionRepository
// (`searchRecipes`), which also covers household-shared recipes and "not
// imported" placeholders. The semantic path falls back to it via
// collectionRepo(ownerId).searchRecipes() in apps/web/src/search.
