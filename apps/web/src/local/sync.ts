import type {
  CollectionRow,
  CollectionNoteRow,
  CookingEventRow,
  IngredientRow,
  InstructionRefRow,
  InstructionRow,
  Json,
  RecipeRow,
  RecipeTagRow,
} from '@cookyourbooks/db';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@cookyourbooks/db';
import { getLocalDb } from './db.js';
import {
  purgeCollection,
  purgeRecipe,
  upsertCollectionRow,
  upsertCollectionsBatch,
  upsertCookingEventRow,
  upsertRecipeTagRow,
  upsertCollectionNoteRow,
  upsertRecipesBatch,
  upsertRecipesBatchInner,
  recipeBatchRowCount,
  PULL_CRR_TABLES,
  withSuppressedCrrTriggers,
  filterFresherIncoming,
  bulkInsertOnConflictId,
  bulkInsertIgnoreId,
  upsertLocalEmbeddingsBatch,
  upsertLocalEmbedding,
  deleteLocalEmbedding,
  getLocalEmbedding,
  type LocalEmbeddingRow,
  type RecipeBatchEntry,
} from './repositories.js';
import {
  listPending,
  markDone,
  markFailed,
  pendingDeleteIds,
  type OutboxEntry,
  type OutboxKind,
} from './outbox.js';
import { logSync } from './syncLog.js';
import { reportError } from '../sentry.js';
import { claimsFromSession } from '../auth/claims.js';

type CookbooksClient = SupabaseClient<Database>;

// ---------- watermark helpers ----------

export async function getWatermark(topic: string): Promise<number> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ high_water_mark: number }>(
    `select high_water_mark from sync_state where topic = ?`,
    [topic],
  )) as { high_water_mark: number }[];
  return rows[0]?.high_water_mark ?? 0;
}

/** Debug helper: enumerate every sync watermark for the diagnostics panel. */
export async function listWatermarks(): Promise<{ topic: string; high_water_mark: number }[]> {
  const db = await getLocalDb();
  return (await db.execO<{ topic: string; high_water_mark: number }>(
    `select topic, high_water_mark from sync_state order by topic`,
  )) as { topic: string; high_water_mark: number }[];
}

export async function bumpWatermark(topic: string, value: number): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into sync_state (topic, high_water_mark) values (?, ?)
     on conflict(topic) do update set
       high_water_mark = max(sync_state.high_water_mark, excluded.high_water_mark)`,
    [topic, value],
  );
}

/**
 * Drop every per-household watermark for the user so the next pull is a full
 * household re-pull. Used when membership or a co-member's library sharing
 * changes: a freshly-shared back-catalog carries old `updated_at` values that
 * the incremental watermark would skip, so the only way to surface it is to
 * start the household topics over from 0. Owned-content watermarks are left
 * untouched. (`_` in the prefix is a LIKE wildcard but the literal topics all
 * start with `household_`, so the match is exact enough.)
 */
export async function resetHouseholdWatermarks(ownerId: string): Promise<void> {
  const db = await getLocalDb();
  await db.exec(`delete from sync_state where topic like ?`, [`household_%:${ownerId}:%`]);
}

function toMs(ts: string | number | null | undefined): number {
  if (typeof ts === 'number') return ts;
  if (!ts) return 0;
  const p = Date.parse(ts);
  return Number.isFinite(p) ? p : 0;
}

// ---------- composite keyset cursor (recipes topics) ----------
//
// The incremental recipes pull keysets on (updated_at, id) rather than a bare
// `updated_at >= ms`. A bare ms watermark cannot advance past a block of rows
// that share one updated_at — every row is `>= ms`, so each pull re-selects
// the whole block forever. That's exactly what the 20260623000100 backfill
// created: a plain UPDATE fired touch_updated_at and stamped one identical
// timestamp on every recipe, so a large library re-pulled in full each cycle
// and the O(table-size) crsql_commit_alter wedged it past the 45s watchdog.
// The (ts, id) cursor pins the exact last row seen so the next pull starts
// STRICTLY after it.
//
// We store the EXACT server updated_at string (sub-ms precision), not the
// truncated ms — an `eq` on a truncated ms would never match the real row,
// leaving the id tiebreaker dead and the tie-trap intact.

interface RecipeCursor {
  /** Exact server updated_at of the last row pulled. */
  ts: string;
  /** Row id at that updated_at; '' = no keyset cursor yet → full pull. */
  id: string;
}

async function getRecipeCursor(topic: string): Promise<RecipeCursor> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ high_water_ts: string; high_water_id: string }>(
    `select high_water_ts, high_water_id from sync_state where topic = ?`,
    [topic],
  )) as { high_water_ts: string; high_water_id: string }[];
  const row = rows[0];
  if (!row) return { ts: '', id: '' };
  return { ts: row.high_water_ts || '', id: row.high_water_id || '' };
}

async function setRecipeCursor(topic: string, cursor: RecipeCursor): Promise<void> {
  const db = await getLocalDb();
  // Written unconditionally: only pullAll writes recipe cursors, it runs as a
  // single coalesced leader, and within a pull the cursor only advances
  // (keyset order), so there is no concurrent writer to guard against.
  await db.exec(
    `insert into sync_state (topic, high_water_mark, high_water_ts, high_water_id)
     values (?, ?, ?, ?)
     on conflict(topic) do update set
       high_water_mark = excluded.high_water_mark,
       high_water_ts = excluded.high_water_ts,
       high_water_id = excluded.high_water_id`,
    [topic, toMs(cursor.ts), cursor.ts, cursor.id],
  );
}

/**
 * Fold rows into a running max (updated_at, id) cursor. Lexicographic compare
 * on the server's timestamptz output (`…+00:00`) is chronological, so plain
 * `>` works — provided both operands are server-form. Always seed the running
 * cursor from `{ ts: '', id: '' }` (or a prior server-form cursor), never from
 * the legacy ms-derived `…Z` seed, whose zone suffix sorts differently.
 */
function maxCursor(
  rows: ReadonlyArray<{ updated_at: string; id: string }>,
  start: RecipeCursor,
): RecipeCursor {
  let best = start;
  for (const r of rows) {
    if (r.updated_at > best.ts || (r.updated_at === best.ts && r.id > best.id)) {
      best = { ts: r.updated_at, id: r.id };
    }
  }
  return best;
}

// PostgREST/PG compare timestamps by instant, so normalizing the stored
// `+00:00` zone to `Z` for a filter value is semantically identical and
// sidesteps any `+`-encoding ambiguity in the query string. No-op on the
// already-`Z` legacy seed.
function tsForFilter(ts: string): string {
  return ts.replace('+00:00', 'Z');
}

/** Keyset WHERE ordered by (updated_at, <idCol>): rows strictly after the
 *  cursor. The tiebreaker column is `id` for recipes, `recipe_id` for the
 *  recipe_embeddings pulls. */
function updatedKeysetOr(cur: RecipeCursor, idCol: string): string {
  const ts = tsForFilter(cur.ts);
  return `updated_at.gt.${ts},and(updated_at.eq.${ts},${idCol}.gt.${cur.id})`;
}

/** Keyset WHERE for the incremental recipes pull (tiebreaker `id`). */
function recipeKeysetOr(cur: RecipeCursor): string {
  return updatedKeysetOr(cur, 'id');
}

/**
 * Drive a keyset-paginated query ordered by (updated_at, <id>). Each page
 * starts strictly after the previous page's last row, so depth is O(PAGE_SIZE)
 * per page and a block of equal-timestamp rows is walked by the tiebreaker
 * rather than re-selected. Stops when a short page arrives. `idOf` extracts the
 * tiebreaker value from a row (defaults to `id`; embeddings pass `recipe_id`).
 */
async function fetchAllByUpdatedKeyset<T extends { updated_at: string }>(
  build: (cur: RecipeCursor) => PromiseLike<PageResult>,
  start: RecipeCursor,
  idOf: (row: T) => string = (row) => (row as unknown as { id: string }).id,
): Promise<T[]> {
  const out: T[] = [];
  let cur = start;
  while (true) {
    const { data, error } = await build(cur);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    const last = rows[rows.length - 1]!;
    cur = { ts: last.updated_at, id: idOf(last) };
  }
  return out;
}

// PostgREST silently caps responses at the project's max-rows setting
// (1000 by default on Supabase). For libraries with > PAGE_SIZE rows,
// every `pullAll` table query has to page with `.range()` or new rows
// past the cap never reach the local cache. PAGE_SIZE matches the
// server cap so a "fewer than PAGE_SIZE returned" check is a reliable
// end-of-stream signal.
const PAGE_SIZE = 1000;

// Modest — the prod PG instance is small (512MB / fractional CPU), so we
// fan out a handful of pages at a time rather than opening a connection
// per page. Kept low because the full-pull fan-out otherwise floods the
// box with concurrent queries and trips the 8s statement timeout (57014).
const PAGE_CONCURRENCY = 2;

// Local upsert + watermark-checkpoint chunk for the recipes pull. The
// recipe rows come back ordered by (updated_at, id), so upserting them in
// ordered chunks and bumping the watermark after each chunk means a
// mid-pull interruption (CYCLE_TIMEOUT, killed tab, slow iPad WASM writes)
// resumes from the last completed chunk instead of restarting the batch.
const RECIPE_CHECKPOINT_CHUNK = 250;

interface PageResult {
  data: unknown[] | null;
  error: unknown;
}

/**
 * Drive a paginated PostgREST query until exhausted. The builder is
 * re-invoked per page so each call gets a fresh query with its own
 * `.range(from, to)` window; supabase-js query builders aren't safe to
 * mutate-then-reuse, which is why we don't accept a prebuilt query.
 * Result rows come back untyped — supabase-js's row types use the raw
 * Postgres column types (e.g., `status: string` for check-constrained
 * text columns) while we want narrower TS unions, so callers cast.
 * Page 0 is fetched alone (incremental pulls stay one request); larger
 * results fan out the remaining pages in concurrent waves.
 */
async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const out: T[] = [];
  // Page 0 alone: incremental / small pulls are a single short page, so the
  // common case stays exactly one request and never fans out.
  const first = await build(0, PAGE_SIZE - 1);
  if (first.error) throw first.error;
  const firstRows = (first.data ?? []) as T[];
  out.push(...firstRows);
  if (firstRows.length < PAGE_SIZE) return out;
  // Big result: fetch the remaining pages in concurrent waves of disjoint
  // `.range()` windows. Promise.all preserves order within a wave and waves
  // are sequential, so `out` stays in the query's sort order.
  for (let wave = 0; ; wave += 1) {
    const base = 1 + wave * PAGE_CONCURRENCY;
    const pages = await Promise.all(
      Array.from({ length: PAGE_CONCURRENCY }, (_, i) => {
        const from = (base + i) * PAGE_SIZE;
        return build(from, from + PAGE_SIZE - 1);
      }),
    );
    let reachedEnd = false;
    for (const { data, error } of pages) {
      if (error) throw error;
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < PAGE_SIZE) reachedEnd = true;
    }
    if (reachedEnd) break;
  }
  return out;
}

/**
 * Keyset pagination by `id`, sequential. Each page is `where id > <last id>
 * order by id limit PAGE_SIZE`, so it's an O(PAGE_SIZE) primary-key range
 * scan regardless of depth — unlike `.range()`/OFFSET, which re-scans
 * O(offset) rows per page (a 16k-row table scans the whole table on every
 * deep page). Used for the big full-pull queries where OFFSET depth +
 * concurrency were tripping the 8s statement timeout. The caller's result
 * order doesn't matter here — children are grouped by recipe_id locally and
 * recipes are upserted by id — so ordering by id (instead of updated_at) is
 * fine, and it's the column with a usable keyset index (the PK).
 */
async function fetchAllByIdKeyset<T extends { id: string }>(
  build: (afterId: string | null) => PromiseLike<PageResult>,
): Promise<T[]> {
  const out: T[] = [];
  let afterId: string | null = null;
  while (true) {
    const { data, error } = await build(afterId);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    afterId = rows[rows.length - 1]!.id;
  }
  return out;
}

// Max ids per `.in(...)` filter — keeps the request URL well under
// PostgREST's ceiling (mirrors packages/db's IN_CHUNK_SIZE). Each chunk is
// paged independently; a given parent id lands entirely within one chunk, so
// per-parent ordering is preserved even though chunks aren't globally ordered.
const IN_CHUNK_SIZE = 200;

/**
 * Fetch all rows matching an `.in(column, ids)` filter, chunking the id list
 * and paging each chunk. Used for incremental child pulls: we already know
 * exactly which recipe / instruction ids changed (from the parent fetch), so
 * we filter children by id instead of re-joining `recipes` for its
 * `updated_at` — no embed for PostgREST to buffer, no embedded column to strip.
 */
async function fetchAllChunkedIn<T>(
  ids: readonly string[],
  build: (chunk: string[], from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_CHUNK_SIZE);
    out.push(...(await fetchAllPages<T>((from, to) => build(chunk, from, to))));
  }
  return out;
}

// ---------- pull ----------

export interface PullResult {
  collections: number;
  recipes: number;
  ingredients: number;
  instructions: number;
  importBatches: number;
  importItems: number;
  importItemAttempts: number;
  importTocEntries: number;
  conversionRules: number;
  rewriteJobs: number;
  remixJobs: number;
  recipeEmbeddings: number;
  cookingEvents: number;
  recipeTags: number;
  collectionNotes: number;
  /** Collections + their children pulled because they're shared into the user's household. */
  householdSharedCollections: number;
  /** The user's active household id at pull time (null if none). */
  householdId: string | null;
}

/**
 * The user's currently-active household, read from the JWT `household_id`
 * claim stamped by the custom_access_token_hook. The claim is re-minted on
 * every household transition (household/api.ts refreshes the session after
 * create/accept/leave/delete), so this tracks membership with no query —
 * replacing the old per-pull household_members round-trip.
 */
async function getCurrentHouseholdId(client: CookbooksClient): Promise<string | null> {
  const { data } = await client.auth.getSession();
  return claimsFromSession(data.session).householdId;
}

interface ConversionRuleRow {
  id: string;
  owner_id: string;
  recipe_id: string | null;
  from_unit: string;
  to_unit: string;
  factor: number;
  ingredient_name: string | null;
  notes: string | null;
  priority: 'HOUSE' | 'RECIPE' | 'STANDARD' | 'GLOBAL';
  created_at: string;
  updated_at: string;
}

// ---------- bulk OCR import: local row shapes ----------
//
// The server tables generate types via `gen-types`, but Wave 1 lands
// before those types regenerate. Until then we describe the columns we
// touch right here. The shapes mirror the Postgres schema in
// `20260522000000_imports.sql` 1:1.

interface ImportBatchRow {
  id: string;
  owner_id: string;
  name: string;
  batch_kind: 'STANDARD' | 'BAKEOFF';
  source_kind: 'IMAGES' | 'PDF';
  target_collection_id: string | null;
  default_model: string;
  default_provider: 'gemini' | 'openai-compatible';
  default_prompt: string | null;
  fallback_model: string | null;
  fallback_provider: 'gemini' | 'openai-compatible' | null;
  key_owner_id: string | null;
  recitation_policy: 'ASK' | 'FALLBACK' | 'FAIL';
  status: 'OPEN' | 'ARCHIVED';
  total_items: number;
  is_planner: boolean;
  created_at: string;
  updated_at: string;
}

interface ImportItemRow {
  id: string;
  batch_id: string;
  owner_id: string;
  page_index: number;
  storage_path: string;
  thumb_path: string | null;
  source_pdf_path: string | null;
  source_pdf_page: number | null;
  assigned_collection_id: string | null;
  assigned_page_number: number | null;
  assigned_recipe_id: string | null;
  is_toc: boolean;
  kind: string;
  status:
    | 'AWAITING_GROUPING'
    | 'BAKEOFF_PENDING'
    | 'BAKEOFF_READY'
    | 'PENDING'
    | 'CLAIMED'
    | 'OCR_DONE'
    | 'NEEDS_FALLBACK'
    | 'OCR_FAILED'
    | 'REVIEWED'
    | 'DISCARDED';
  selected_variant_id: string | null;
  claim_expires_at: string;
  attempts: number;
  last_error: string | null;
  parsed_drafts_json: unknown;
  model_used: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_micros: number;
  created_recipe_ids: string[];
  needs_fallback: boolean;
  extra_storage_paths: string[];
  created_at: string;
  updated_at: string;
}

interface ImportItemAttemptRow {
  id: string;
  item_id: string;
  owner_id: string;
  attempt_no: number;
  provider: string;
  model: string;
  raw_response_path: string | null;
  error_kind: string | null;
  error_message: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_micros: number;
  latency_ms: number;
  started_at: string;
  finished_at: string | null;
}

interface ImportTocEntryRow {
  id: string;
  batch_id: string;
  item_id: string;
  owner_id: string;
  title: string;
  page_number: number | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface RecipeEmbeddingRow {
  recipe_id: string;
  /** Postgres `vector(384)` returns as either a numeric[] (when the
   *  PostgREST cast handler is configured) or a textual `[1.23,...]`
   *  representation. We accept both. */
  embedding: number[] | string;
  text_hash: string;
  model: string;
  updated_at: string;
}

interface RewriteJobRow {
  id: string;
  owner_id: string;
  recipe_id: string;
  status: 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';
  provider: 'gemini' | 'openai-compatible';
  model: string;
  prompt: string;
  claim_expires_at: string;
  attempts: number;
  last_error: string | null;
  result_json: unknown;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_micros: number;
  latency_ms: number;
  created_at: string;
  updated_at: string;
}

interface RemixJobRow {
  id: string;
  owner_id: string;
  recipe_id: string;
  status: 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';
  provider: 'gemini' | 'openai-compatible';
  model: string;
  prompt: string;
  instruction: string;
  claim_expires_at: string;
  attempts: number;
  last_error: string | null;
  // The produced ParsedRecipeDraft; the client promotes it into a new recipe.
  result_json: unknown;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_micros: number;
  latency_ms: number;
  created_at: string;
  updated_at: string;
}

// Bumped whenever a sync bug invalidates existing watermarks. On the
// first pull after the user upgrades, every per-topic watermark is
// reset to 0 so missed rows get a chance to flow in. Increment when
// fixing a pull bug that could have stranded server rows.
//
// v5 (2026-06-17): added cooking_events + recipe_tags topics — reset so
// existing users do a clean first pull of the new tables. (The merge also
// brought the recipe_embeddings topic; it's new, so it full-pulls from
// watermark 0 on its own — included in the reset below as belt-and-suspenders.)
// v6 (2026-06-25): added collection_notes — reset so existing users do a clean
// first pull of the new table.
// v7 (2026-06-27): added the remix_jobs topic (merged alongside v6) — bump so
// users who already reached v6 (collection_notes) also reset remix_jobs.
const SYNC_RESET_VERSION = 7;

async function maybeResetWatermarks(ownerId: string): Promise<void> {
  const versionTopic = `sync_reset_version:${ownerId}`;
  const current = await getWatermark(versionTopic);
  if (current >= SYNC_RESET_VERSION) return;
  const db = await getLocalDb();
  await db.exec(
    `delete from sync_state where topic in (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `collections:${ownerId}`,
      `recipes:${ownerId}`,
      `import_batches:${ownerId}`,
      `import_items:${ownerId}`,
      `import_item_attempts:${ownerId}`,
      `import_toc_entries:${ownerId}`,
      `conversion_rules:${ownerId}`,
      `rewrite_jobs:${ownerId}`,
      `remix_jobs:${ownerId}`,
      `recipe_embeddings:${ownerId}`,
      `cooking_events:${ownerId}`,
      `recipe_tags:${ownerId}`,
      `collection_notes:${ownerId}`,
    ],
  );
  await bumpWatermark(versionTopic, SYNC_RESET_VERSION);
}

export interface PullCallbacks {
  /**
   * Fired when a major phase finishes writing to local SQLite. Use to
   * invalidate React Query keys incrementally so the UI hydrates as
   * each topic lands instead of waiting for the whole pull to finish.
   */
  onPhaseComplete?: (
    phase:
      | 'collections'
      | 'recipes'
      | 'imports'
      | 'conversion_rules'
      | 'rewrite_jobs'
      | 'remix_jobs'
      | 'recipe_embeddings'
      | 'cooking_events'
      | 'recipe_tags'
      | 'collection_notes',
  ) => void;
}

export async function pullAll(
  client: CookbooksClient,
  ownerId: string,
  signal?: AbortSignal,
  callbacks?: PullCallbacks,
): Promise<PullResult> {
  const pullStart = Date.now();
  logSync('info', 'pullAll: entered');
  await maybeResetWatermarks(ownerId);
  logSync('info', 'pull: start');
  function checkAbort(phase: string) {
    if (signal?.aborted) {
      const err = new Error(`pullAll aborted before ${phase}`);
      logSync('warn', `pullAll: aborted before ${phase}`);
      throw err;
    }
  }
  checkAbort('collections');
  const collectionTopic = `collections:${ownerId}`;
  const collectionsSince = new Date(await getWatermark(collectionTopic)).toISOString();

  const collectionsPhase = Date.now();
  const collections = await fetchAllPages<CollectionRow>((from, to) =>
    client
      .from('recipe_collections')
      .select('*')
      .eq('owner_id', ownerId)
      .gte('updated_at', collectionsSince)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  logSync('info', `pull collections: ${collections.length} rows in ${Date.now() - collectionsPhase}ms`);

  let maxCollectionTs = await getWatermark(collectionTopic);
  await upsertCollectionsBatch(collections);
  for (const row of collections) {
    maxCollectionTs = Math.max(maxCollectionTs, toMs(row.updated_at));
  }
  if (maxCollectionTs > 0) await bumpWatermark(collectionTopic, maxCollectionTs);
  callbacks?.onPhaseComplete?.('collections');

  checkAbort('recipes');
  const recipeTopic = `recipes:${ownerId}`;
  const recipeCursor = await getRecipeCursor(recipeTopic);
  // Children carry denormalized owner_id + household_id (20260623000100), so
  // no child query ever joins `recipes`. Full pull (no cursor yet): fetch by
  // indexed owner_id. Incremental: filter children by the changed recipe ids
  // we just fetched (children have no updated_at of their own).
  //
  // A full pull runs whenever there's no keyset cursor — a brand-new device,
  // OR an existing device upgrading past this change (the high_water_id column
  // is new, so its cursor is empty). Both re-pull the library once via the
  // efficient owner_id path, which also re-establishes a clean (ts, id) cursor.
  // That's the right thing here anyway: the 20260623000100 backfill stamped one
  // shared updated_at on every existing row, so an incremental `>=` would
  // re-pull everything regardless.
  const fullPull = recipeCursor.id === '';
  const recipesPhase = Date.now();

  // Recipes carry a denormalized `owner_id` (20260623000100), so we filter
  // on it directly — no `recipe_collections!inner(owner_id)` embed for
  // PostgREST to join + buffer, and the owned read resolves via the
  // recipes_owner_* indexes.
  //  - Full pull: keyset by id — PK range scan, O(PAGE_SIZE) per page, so deep
  //    pages don't re-scan the table.
  //  - Incremental: keyset by (updated_at, id) so a block of rows sharing one
  //    updated_at is walked by id, not re-selected forever.
  const recipesFetched: RecipeRow[] = fullPull
    ? await fetchAllByIdKeyset<RecipeRow>((afterId) => {
        let q = client
          .from('recipes')
          .select('*')
          .eq('owner_id', ownerId)
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (afterId) q = q.gt('id', afterId);
        return q;
      })
    : await fetchAllByUpdatedKeyset<RecipeRow>(
        (cur) =>
          client
            .from('recipes')
            .select('*')
            .eq('owner_id', ownerId)
            .or(recipeKeysetOr(cur))
            .order('updated_at', { ascending: true })
            .order('id', { ascending: true })
            .limit(PAGE_SIZE),
        recipeCursor,
      );

  let ingTotal = 0;
  let stepTotal = 0;

  if (recipesFetched.length > 0) {
    // Children carry denormalized owner_id + household_id, so no recipes
    // join is needed.
    //  - Full pull: fetch by indexed owner_id (keyset by id), grouped by
    //    recipe_id locally; sort order is a stored column.
    //  - Incremental: we already hold the exact set of changed recipe ids,
    //    so filter children by `.in('recipe_id', changedIds)` (chunked) — no
    //    `recipes!inner(updated_at)` embed for PostgREST to buffer/strip.
    // refs have no recipe_id (composite PK), so we group them via the
    // instruction->recipe map built from the steps just fetched, and
    // (incremental) fetch them by `.in('instruction_id', changedStepIds)`.
    const changedIds = recipesFetched.map((r) => r.id);
    const [ings, steps] = await Promise.all([
      fullPull
        ? fetchAllByIdKeyset<IngredientRow>((afterId) => {
            let q = client
              .from('ingredients')
              .select('*')
              .eq('owner_id', ownerId)
              .order('id', { ascending: true })
              .limit(PAGE_SIZE);
            if (afterId) q = q.gt('id', afterId);
            return q;
          })
        : fetchAllChunkedIn<IngredientRow>(changedIds, (chunk, from, to) =>
            client
              .from('ingredients')
              .select('*')
              .in('recipe_id', chunk)
              .order('recipe_id', { ascending: true })
              .order('sort_order', { ascending: true })
              .range(from, to),
          ),
      fullPull
        ? fetchAllByIdKeyset<InstructionRow>((afterId) => {
            let q = client
              .from('instructions')
              .select('*')
              .eq('owner_id', ownerId)
              .order('id', { ascending: true })
              .limit(PAGE_SIZE);
            if (afterId) q = q.gt('id', afterId);
            return q;
          })
        : fetchAllChunkedIn<InstructionRow>(changedIds, (chunk, from, to) =>
            client
              .from('instructions')
              .select('*')
              .in('recipe_id', chunk)
              .order('recipe_id', { ascending: true })
              .order('step_number', { ascending: true })
              .range(from, to),
          ),
    ]);

    const refs = fullPull
      ? await fetchAllPages<InstructionRefRow>((from, to) =>
          client
            .from('instruction_ingredient_refs')
            .select('*')
            .eq('owner_id', ownerId)
            .order('instruction_id', { ascending: true })
            .range(from, to),
        )
      : await fetchAllChunkedIn<InstructionRefRow>(
          steps.map((s) => s.id),
          (chunk, from, to) =>
            client
              .from('instruction_ingredient_refs')
              .select('*')
              .in('instruction_id', chunk)
              .order('instruction_id', { ascending: true })
              .range(from, to),
        );

    const ingByRecipe = groupBy(ings, (i) => i.recipe_id);
    const stepsByRecipe = groupBy(steps, (s) => s.recipe_id);
    const recipeByStep = new Map(steps.map((s) => [s.id, s.recipe_id] as [string, string]));
    const refsByRecipe = new Map<string, InstructionRefRow[]>();
    for (const ref of refs) {
      const recipeId = recipeByStep.get(ref.instruction_id);
      if (!recipeId) continue;
      const arr = refsByRecipe.get(recipeId) ?? [];
      arr.push(ref);
      refsByRecipe.set(recipeId, arr);
    }

    // Bulk-upsert the entire recipe batch in one SQLite transaction.
    // Per-recipe upsertRecipeRow each pays a lock + tx start/commit;
    // on iPad WASM SQLite that's ~50ms per recipe, so a 100-recipe
    // pull can take ~30s with the UI deceptively "Synced" and all
    // other readers stuck behind the recipe loop's lock churn.
    const batch: RecipeBatchEntry[] = recipesFetched.map((r) => ({
      recipe: r,
      ingredients: ingByRecipe.get(r.id) ?? [],
      instructions: stepsByRecipe.get(r.id) ?? [],
      refs: refsByRecipe.get(r.id) ?? [],
    }));
    // Hold ONE CRR-trigger suppression boundary across the whole drain.
    // crsql_commit_alter is O(table size); suppressing per chunk paid that
    // full-table cost once per chunk (64 × O(16k) wedged a large library's
    // pull past the 45s watchdog). One boundary runs it exactly once.
    await withSuppressedCrrTriggers(PULL_CRR_TABLES, recipeBatchRowCount(batch), async () => {
      // Cursor handling differs by pull type:
      //  - Incremental: `batch` is (updated_at, id)-ordered, so each chunk's
      //    max (ts, id) is a safe resume point — checkpoint after every chunk,
      //    resuming from the stored (server-form) cursor.
      //  - Full pull: `batch` is id-ordered, so a chunk's max updated_at is NOT
      //    a safe cursor (older rows may sit in a later id-chunk). Checkpoint
      //    once at the end, to the max across all rows.
      let cursor: RecipeCursor = fullPull ? { ts: '', id: '' } : recipeCursor;
      for (let i = 0; i < batch.length; i += RECIPE_CHECKPOINT_CHUNK) {
        if (signal?.aborted) break;
        const chunk = batch.slice(i, i + RECIPE_CHECKPOINT_CHUNK);
        await upsertRecipesBatchInner(chunk, signal);
        for (const { ingredients, instructions } of chunk) {
          ingTotal += ingredients.length;
          stepTotal += instructions.length;
        }
        if (!fullPull) {
          cursor = maxCursor(chunk.map((b) => b.recipe), cursor);
          if (cursor.ts !== '') await setRecipeCursor(recipeTopic, cursor);
        }
      }
      if (fullPull && !signal?.aborted) {
        const finalCursor = maxCursor(recipesFetched, { ts: '', id: '' });
        if (finalCursor.ts !== '') await setRecipeCursor(recipeTopic, finalCursor);
      }
    });
  }
  logSync(
    'info',
    `pull recipes: ${recipesFetched.length} rows in ${Date.now() - recipesPhase}ms`,
  );
  callbacks?.onPhaseComplete?.('recipes');

  // Tail topics (imports, conversion_rules, rewrite_jobs, embeddings)
  // have no FK or RLS dependency on each other. Run them in parallel
  // so network fetches overlap; their local-write phases still
  // serialize on the SQLite mutex, but each phase is now O(few
  // statements) thanks to bulk INSERTs + trigger suppression, so the
  // contention is small.
  checkAbort('imports');
  const importPhase = Date.now();
  const convPhase = Date.now();
  const rewritePhase = Date.now();
  const remixPhase = Date.now();
  const embedPhase = Date.now();
  const cookingPhase = Date.now();
  const tagsPhase = Date.now();
  const notesPhase = Date.now();
  const [
    importCounts,
    conversionRulesPulled,
    rewriteJobsPulled,
    remixJobsPulled,
    recipeEmbeddingsPulled,
    cookingEventsPulled,
    recipeTagsPulled,
    collectionNotesPulled,
  ] = await Promise.all([
    pullImports(client, ownerId).then((c) => {
      logSync('info', `pull imports done in ${Date.now() - importPhase}ms`, { ...c });
      callbacks?.onPhaseComplete?.('imports');
      return c;
    }),
    pullConversionRules(client, ownerId).then((n) => {
      logSync(
        'info',
        `pull conversion_rules: ${n} rows in ${Date.now() - convPhase}ms`,
      );
      callbacks?.onPhaseComplete?.('conversion_rules');
      return n;
    }),
    pullRewriteJobs(client, ownerId).then((n) => {
      logSync(
        'info',
        `pull rewrite_jobs: ${n} rows in ${Date.now() - rewritePhase}ms`,
      );
      callbacks?.onPhaseComplete?.('rewrite_jobs');
      return n;
    }),
    pullRemixJobs(client, ownerId).then((n) => {
      logSync(
        'info',
        `pull remix_jobs: ${n} rows in ${Date.now() - remixPhase}ms`,
      );
      callbacks?.onPhaseComplete?.('remix_jobs');
      return n;
    }),
    pullRecipeEmbeddings(client, ownerId).then((n) => {
      logSync('info', `pull recipe_embeddings: ${n} rows in ${Date.now() - embedPhase}ms`);
      callbacks?.onPhaseComplete?.('recipe_embeddings');
      return n;
    }),
    pullCookingEvents(client, ownerId).then((n) => {
      logSync('info', `pull cooking_events: ${n} rows in ${Date.now() - cookingPhase}ms`);
      callbacks?.onPhaseComplete?.('cooking_events');
      return n;
    }),
    pullRecipeTags(client, ownerId).then((n) => {
      logSync('info', `pull recipe_tags: ${n} rows in ${Date.now() - tagsPhase}ms`);
      callbacks?.onPhaseComplete?.('recipe_tags');
      return n;
    }),
    pullCollectionNotes(client, ownerId).then((n) => {
      logSync('info', `pull collection_notes: ${n} rows in ${Date.now() - notesPhase}ms`);
      callbacks?.onPhaseComplete?.('collection_notes');
      return n;
    }),
  ]);

  // Household-shared content from other members. Done as a separate
  // serial phase (after the parallel tail above) so the watermark for
  // owned content stays clean and so the sync invariant "I'm pulling
  // things I own" doesn't get mixed up with "I'm pulling things shared
  // with me". When the user isn't in a household this is a no-op.
  checkAbort('household');
  const householdPhase = Date.now();
  const householdId = await getCurrentHouseholdId(client);
  const householdSharedCollections = householdId
    ? await pullHouseholdSharedContent(client, ownerId, householdId, signal)
    : 0;
  logSync(
    'info',
    `pull household-shared: ${householdSharedCollections} collections in ${Date.now() - householdPhase}ms`,
    { householdId },
  );

  logSync('info', `pull complete in ${Date.now() - pullStart}ms`);

  return {
    collections: collections.length,
    recipes: recipesFetched.length,
    ingredients: ingTotal,
    instructions: stepTotal,
    importBatches: importCounts.batches,
    importItems: importCounts.items,
    importItemAttempts: importCounts.attempts,
    importTocEntries: importCounts.tocEntries,
    conversionRules: conversionRulesPulled,
    rewriteJobs: rewriteJobsPulled,
    remixJobs: remixJobsPulled,
    recipeEmbeddings: recipeEmbeddingsPulled,
    cookingEvents: cookingEventsPulled,
    recipeTags: recipeTagsPulled,
    collectionNotes: collectionNotesPulled,
    householdSharedCollections,
    householdId,
  };
}

/**
 * Pull the libraries of the other members of the user's household.
 *
 * Sharing is library-wide and membership-driven now: every collection
 * (plus its recipes / ingredients / instructions / refs) owned by a
 * co-member who shares their library carries our `household_id` (the
 * server denorm maintained by refresh_household_denorm), so we fetch by
 * `household_id = <our household> and owner_id <> me` — an indexed,
 * precise filter instead of a broad `owner_id <> me` scan leaning on RLS.
 * New recipes a co-member adds while sharing get our household_id stamped
 * on write, so the `updated_at` watermark picks them up; a fresh
 * share/join is caught by the household-watermark reset on a
 * household_members change (SyncProvider).
 *
 * Watermarked on a per-household topic so switching households forces a
 * fresh pull. Each co-member collection is tagged locally with
 * `shared_with_household_id = householdId` (a local-only marker — the
 * server column is vestigial) so the library read surfaces it and the
 * "Shared with household" badge renders.
 */
async function pullHouseholdSharedContent(
  client: CookbooksClient,
  ownerId: string,
  householdId: string,
  signal?: AbortSignal,
): Promise<number> {
  const collectionTopic = `household_collections:${ownerId}:${householdId}`;
  const recipeTopic = `household_recipes:${ownerId}:${householdId}`;

  const collectionsSince = new Date(await getWatermark(collectionTopic)).toISOString();
  const collections = await fetchAllPages<CollectionRow>((from, to) =>
    client
      .from('recipe_collections')
      .select('*')
      .eq('household_id', householdId)
      .neq('owner_id', ownerId)
      .gte('updated_at', collectionsSince)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  let maxCollectionTs = await getWatermark(collectionTopic);
  // Batch the upsert (was a per-row loop — the same lock-churn N+1 the
  // owned path eliminated, on a now-default-on feature). The local-only
  // shared_with_household_id marker is what LocalRecipeCollectionRepository
  // keys off to surface these as household-shared.
  await upsertCollectionsBatch(
    collections.map((row) => ({ ...row, shared_with_household_id: householdId })),
  );
  for (const row of collections) {
    maxCollectionTs = Math.max(maxCollectionTs, toMs(row.updated_at));
  }
  if (maxCollectionTs > 0) await bumpWatermark(collectionTopic, maxCollectionTs);

  // Recipes inside co-members' shared libraries — filtered by our
  // household_id (+ owner_id <> me); RLS confirms. Pagination mirrors the
  // owned-content path.
  const recipeCursor = await getRecipeCursor(recipeTopic);
  const fullPull = recipeCursor.id === '';
  // Filter on the denormalized household_id (+ owner_id <> me) — indexed and
  // join-free, like the owned path's owner_id filter. Same two pull shapes as
  // the owned path: full keyset-by-id, then incremental keyset-by-(updated_at,
  // id) so equal-timestamp blocks are walked rather than re-selected.
  const recipes: RecipeRow[] = fullPull
    ? await fetchAllByIdKeyset<RecipeRow>((afterId) => {
        let q = client
          .from('recipes')
          .select('*')
          .eq('household_id', householdId)
          .neq('owner_id', ownerId)
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (afterId) q = q.gt('id', afterId);
        return q;
      })
    : await fetchAllByUpdatedKeyset<RecipeRow>(
        (cur) =>
          client
            .from('recipes')
            .select('*')
            .eq('household_id', householdId)
            .neq('owner_id', ownerId)
            .or(recipeKeysetOr(cur))
            .order('updated_at', { ascending: true })
            .order('id', { ascending: true })
            .limit(PAGE_SIZE),
        recipeCursor,
      );

  if (recipes.length > 0) {
    // Same join-free child pulls as the owned path: full by household_id,
    // incremental by the changed recipe / instruction ids.
    const changedIds = recipes.map((r) => r.id);
    const [ings, steps] = await Promise.all([
      fullPull
        ? fetchAllPages<IngredientRow>((from, to) =>
            client
              .from('ingredients')
              .select('*')
              .eq('household_id', householdId)
              .neq('owner_id', ownerId)
              .order('recipe_id', { ascending: true })
              .order('sort_order', { ascending: true })
              .range(from, to),
          )
        : fetchAllChunkedIn<IngredientRow>(changedIds, (chunk, from, to) =>
            client
              .from('ingredients')
              .select('*')
              .in('recipe_id', chunk)
              .order('recipe_id', { ascending: true })
              .order('sort_order', { ascending: true })
              .range(from, to),
          ),
      fullPull
        ? fetchAllPages<InstructionRow>((from, to) =>
            client
              .from('instructions')
              .select('*')
              .eq('household_id', householdId)
              .neq('owner_id', ownerId)
              .order('recipe_id', { ascending: true })
              .order('step_number', { ascending: true })
              .range(from, to),
          )
        : fetchAllChunkedIn<InstructionRow>(changedIds, (chunk, from, to) =>
            client
              .from('instructions')
              .select('*')
              .in('recipe_id', chunk)
              .order('recipe_id', { ascending: true })
              .order('step_number', { ascending: true })
              .range(from, to),
          ),
    ]);

    const refs = fullPull
      ? await fetchAllPages<InstructionRefRow>((from, to) =>
          client
            .from('instruction_ingredient_refs')
            .select('*')
            .eq('household_id', householdId)
            .neq('owner_id', ownerId)
            .order('instruction_id', { ascending: true })
            .range(from, to),
        )
      : await fetchAllChunkedIn<InstructionRefRow>(
          steps.map((s) => s.id),
          (chunk, from, to) =>
            client
              .from('instruction_ingredient_refs')
              .select('*')
              .in('instruction_id', chunk)
              .order('instruction_id', { ascending: true })
              .range(from, to),
        );

    const ingByRecipe = groupBy(ings, (i) => i.recipe_id);
    const stepsByRecipe = groupBy(steps, (s) => s.recipe_id);
    const recipeByStep = new Map(steps.map((s) => [s.id, s.recipe_id] as [string, string]));
    const refsByRecipe = new Map<string, InstructionRefRow[]>();
    for (const ref of refs) {
      const recipeId = recipeByStep.get(ref.instruction_id);
      if (!recipeId) continue;
      const arr = refsByRecipe.get(recipeId) ?? [];
      arr.push(ref);
      refsByRecipe.set(recipeId, arr);
    }

    const batch: RecipeBatchEntry[] = recipes.map((r) => ({
      recipe: r,
      ingredients: ingByRecipe.get(r.id) ?? [],
      instructions: stepsByRecipe.get(r.id) ?? [],
      refs: refsByRecipe.get(r.id) ?? [],
    }));
    // One CRR-trigger suppression boundary + checkpointed chunks, mirroring
    // the owned path so a large shared library doesn't pay a per-chunk
    // O(table) commit_alter and the cursor steps past equal-timestamp blocks.
    await withSuppressedCrrTriggers(PULL_CRR_TABLES, recipeBatchRowCount(batch), async () => {
      let cursor: RecipeCursor = fullPull ? { ts: '', id: '' } : recipeCursor;
      for (let i = 0; i < batch.length; i += RECIPE_CHECKPOINT_CHUNK) {
        if (signal?.aborted) break;
        const chunk = batch.slice(i, i + RECIPE_CHECKPOINT_CHUNK);
        await upsertRecipesBatchInner(chunk, signal);
        if (!fullPull) {
          cursor = maxCursor(chunk.map((b) => b.recipe), cursor);
          if (cursor.ts !== '') await setRecipeCursor(recipeTopic, cursor);
        }
      }
      if (fullPull && !signal?.aborted) {
        const finalCursor = maxCursor(recipes, { ts: '', id: '' });
        if (finalCursor.ts !== '') await setRecipeCursor(recipeTopic, finalCursor);
      }
    });
  }

  // Co-members' cooking activity + tags. RLS narrows `owner_id <> me` to
  // library-sharing co-members; each row is tagged locally with
  // shared_with_household_id so the repository surfaces it. Side effects —
  // the caller only logs the collection count.
  await pullHouseholdCookingEvents(client, ownerId, householdId);
  await pullHouseholdRecipeTags(client, ownerId, householdId);
  await pullHouseholdCollectionNotes(client, ownerId, householdId);
  // Co-members' recipe vectors, so household-shared recipes are semantically
  // searchable (not just literal-fallback). Tagged into the local mirror by
  // recipe_id; the collection's shared_with_household_id marker is what
  // listSearchableEmbeddings joins on to surface them.
  await pullHouseholdEmbeddings(client, ownerId, householdId);

  return collections.length;
}

// ---------- nutrition essentials (USDA Foundation + SR Legacy) ----------
//
// Pulled separately from pullAll because it's reference data, not user
// data — slow first load shouldn't block the recipes from appearing.
// Run once per device on first sign-in; refresh monthly to pick up
// upstream changes. Branded stays server-only (500k rows is too much
// to mirror to every client).
const NUTRITION_ESSENTIALS_TOPIC = 'nutrition_essentials';
const NUTRITION_ESSENTIALS_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

interface EssentialsRow {
  source: string;
  source_id: string;
  data_type: string;
  description: string;
  brand: string | null;
  brand_owner: string | null;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  saturated_fat_g: number | null;
  carbs_g: number | null;
  sugar_g: number | null;
  fiber_g: number | null;
  sodium_mg: number | null;
  portions: { unit: string; grams: number }[] | null;
}

export async function pullNutritionEssentials(
  client: CookbooksClient,
  opts: { force?: boolean } = {},
): Promise<number> {
  const watermark = await getWatermark(NUTRITION_ESSENTIALS_TOPIC);
  const fresh = watermark > 0 && Date.now() - watermark < NUTRITION_ESSENTIALS_REFRESH_MS;
  if (fresh && !opts.force) {
    logSync('info', `nutrition essentials: fresh (last pull ${new Date(watermark).toISOString()})`);
    return 0;
  }

  const t0 = Date.now();
  logSync('info', 'nutrition essentials: pulling Foundation + SR Legacy');

  // gen-types hasn't seen 20260608000100_nutrition_foods_master yet,
  // so the literal-union .from() overload rejects the table name. Cast
  // around it until the next type regen.
  const untyped = client as unknown as {
    from: (
      table: string,
    ) => {
      select: (cols: string) => {
        in: (
          col: string,
          vals: string[],
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            range: (from: number, to: number) => PromiseLike<PageResult>;
          };
        };
      };
    };
  };
  const rows = await fetchAllPages<EssentialsRow>((from, to) =>
    untyped
      .from('nutrition_foods_master')
      .select(
        'source,source_id,data_type,description,brand,brand_owner,' +
          'calories_kcal,protein_g,fat_g,saturated_fat_g,carbs_g,sugar_g,fiber_g,sodium_mg,portions',
      )
      .in('data_type', ['Foundation', 'SR Legacy'])
      .order('source_id', { ascending: true })
      .range(from, to),
  );

  await upsertEssentialsBatch(rows);
  await bumpWatermark(NUTRITION_ESSENTIALS_TOPIC, Date.now());
  logSync(
    'info',
    `nutrition essentials: ${rows.length} rows in ${Date.now() - t0}ms`,
  );
  return rows.length;
}

async function upsertEssentialsBatch(rows: EssentialsRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getLocalDb();
  // Chunk so a 7k-row pull doesn't hold the db-lock queue for several
  // seconds in one go — other ops can interleave between chunks.
  // CHUNK=500: 500 × 16 cols = 8000 params, well under SQLite's 32766 ceiling.
  const CHUNK = 500;

  const cols = [
    'source', 'source_id', 'data_type', 'description', 'brand', 'brand_owner',
    'calories_kcal', 'protein_g', 'fat_g', 'saturated_fat_g',
    'carbs_g', 'sugar_g', 'fiber_g', 'sodium_mg', 'portions', 'search_blob',
  ] as const;
  const tuple = `(${cols.map(() => '?').join(',')})`;
  const setClause = cols
    .filter((c) => c !== 'source' && c !== 'source_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(',\n             ');

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    for (const r of chunk) {
      const blob = [r.description, r.brand ?? '', r.brand_owner ?? '']
        .join(' ')
        .toLowerCase();
      params.push(
        r.source,
        r.source_id,
        r.data_type,
        r.description,
        r.brand,
        r.brand_owner,
        r.calories_kcal,
        r.protein_g,
        r.fat_g,
        r.saturated_fat_g,
        r.carbs_g,
        r.sugar_g,
        r.fiber_g,
        r.sodium_mg,
        JSON.stringify(r.portions ?? []),
        blob,
      );
    }
    await db.exec(
      `insert into nutrition_foods_essentials (${cols.join(',')})
       values ${chunk.map(() => tuple).join(',')}
       on conflict(source, source_id) do update set
             ${setClause}`,
      params as never[],
    );
  }
}

// Column lists for the tail tables' bulk INSERTs. Keep these in sync
// with the local SQLite schema in `schema.ts` and the per-row upsert
// builders below (the per-row paths are still used by the realtime
// event handlers so they aren't dead).
const CONVERSION_RULE_COLS = [
  'id',
  'owner_id',
  'recipe_id',
  'from_unit',
  'to_unit',
  'factor',
  'ingredient_name',
  'notes',
  'priority',
  'updated_at',
  'deleted',
] as const;

const REWRITE_JOB_COLS = [
  'id',
  'owner_id',
  'recipe_id',
  'status',
  'provider',
  'model',
  'prompt',
  'claim_expires_at',
  'attempts',
  'last_error',
  'result_json',
  'prompt_tokens',
  'completion_tokens',
  'cost_usd_micros',
  'latency_ms',
  'updated_at',
  'deleted',
] as const;

const REMIX_JOB_COLS = [
  'id',
  'owner_id',
  'recipe_id',
  'status',
  'provider',
  'model',
  'prompt',
  'instruction',
  'claim_expires_at',
  'attempts',
  'last_error',
  'result_json',
  'prompt_tokens',
  'completion_tokens',
  'cost_usd_micros',
  'latency_ms',
  'updated_at',
  'deleted',
] as const;

const COOKING_EVENT_COLS = [
  'id',
  'owner_id',
  'recipe_id',
  'status',
  'event_date',
  'occasion_category',
  'meal_slot',
  'occasion_note',
  'notes',
  'adjustments',
  'recipe_snapshot',
  'photo_paths',
  'shared_with_household_id',
  'updated_at',
  'deleted',
] as const;

const RECIPE_TAG_COLS = [
  'id',
  'owner_id',
  'recipe_id',
  'label',
  'shared_with_household_id',
  'updated_at',
  'deleted',
] as const;

const COLLECTION_NOTE_COLS = [
  'id',
  'collection_id',
  'owner_id',
  'import_item_id',
  'title',
  'body',
  'source_image_text',
  'page_numbers',
  'sort_order',
  'shared_with_household_id',
  'updated_at',
  'deleted',
] as const;

const IMPORT_BATCH_COLS = [
  'id',
  'owner_id',
  'name',
  'batch_kind',
  'source_kind',
  'target_collection_id',
  'default_model',
  'default_provider',
  'default_prompt',
  'fallback_model',
  'fallback_provider',
  'key_owner_id',
  'recitation_policy',
  'status',
  'total_items',
  'is_planner',
  'updated_at',
  'deleted',
] as const;

const IMPORT_ITEM_COLS = [
  'id',
  'batch_id',
  'owner_id',
  'page_index',
  'storage_path',
  'thumb_path',
  'source_pdf_path',
  'source_pdf_page',
  'assigned_collection_id',
  'assigned_page_number',
  'assigned_recipe_id',
  'is_toc',
  'kind',
  'status',
  'claim_expires_at',
  'attempts',
  'last_error',
  'parsed_drafts_json',
  'model_used',
  'prompt_tokens',
  'completion_tokens',
  'cost_usd_micros',
  'created_recipe_ids',
  'selected_variant_id',
  'needs_fallback',
  'extra_storage_paths',
  'updated_at',
  'deleted',
] as const;

const IMPORT_ITEM_ATTEMPT_COLS = [
  'id',
  'item_id',
  'owner_id',
  'attempt_no',
  'provider',
  'model',
  'raw_response_path',
  'error_kind',
  'error_message',
  'prompt_tokens',
  'completion_tokens',
  'cost_usd_micros',
  'latency_ms',
  'started_at',
  'finished_at',
  'updated_at',
  'deleted',
] as const;

const IMPORT_TOC_COLS = [
  'id',
  'batch_id',
  'item_id',
  'owner_id',
  'title',
  'page_number',
  'confidence',
  'updated_at',
  'deleted',
] as const;

function conversionRuleToParams(row: ConversionRuleRow): readonly unknown[] {
  return [
    row.id,
    row.owner_id,
    row.recipe_id,
    row.from_unit,
    row.to_unit,
    row.factor,
    row.ingredient_name,
    row.notes,
    row.priority,
    toMs(row.updated_at),
    0,
  ];
}

function rewriteJobToParams(row: RewriteJobRow): readonly unknown[] {
  const resultText =
    row.result_json === null || row.result_json === undefined
      ? null
      : JSON.stringify(row.result_json);
  return [
    row.id,
    row.owner_id,
    row.recipe_id,
    row.status,
    row.provider,
    row.model,
    row.prompt,
    toMs(row.claim_expires_at),
    row.attempts,
    row.last_error,
    resultText,
    row.prompt_tokens,
    row.completion_tokens,
    row.cost_usd_micros,
    row.latency_ms,
    toMs(row.updated_at),
    0,
  ];
}

function remixJobToParams(row: RemixJobRow): readonly unknown[] {
  const resultText =
    row.result_json === null || row.result_json === undefined
      ? null
      : JSON.stringify(row.result_json);
  return [
    row.id,
    row.owner_id,
    row.recipe_id,
    row.status,
    row.provider,
    row.model,
    // Coalesce: realtime UPDATE payloads omit unchanged TOASTed columns (the
    // large `prompt`), and these aren't read locally. See upsertRemixJobRow.
    row.prompt ?? '',
    row.instruction ?? '',
    toMs(row.claim_expires_at),
    row.attempts,
    row.last_error,
    resultText,
    row.prompt_tokens,
    row.completion_tokens,
    row.cost_usd_micros,
    row.latency_ms,
    toMs(row.updated_at),
    0,
  ];
}

function cookingEventToParams(
  row: CookingEventRow,
  householdId: string | null,
): readonly unknown[] {
  const adjustments =
    row.adjustments === null || row.adjustments === undefined
      ? '[]'
      : JSON.stringify(row.adjustments);
  const snapshot =
    row.recipe_snapshot === null || row.recipe_snapshot === undefined
      ? null
      : JSON.stringify(row.recipe_snapshot);
  const photoPaths =
    row.photo_paths === null || row.photo_paths === undefined
      ? '[]'
      : JSON.stringify(row.photo_paths);
  return [
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
    householdId,
    toMs(row.updated_at),
    0,
  ];
}

function recipeTagToParams(
  row: RecipeTagRow,
  householdId: string | null,
): readonly unknown[] {
  return [
    row.id,
    row.owner_id,
    row.recipe_id,
    row.label,
    householdId,
    toMs(row.updated_at),
    0,
  ];
}

function collectionNoteToParams(
  row: CollectionNoteRow,
  householdId: string | null,
): readonly unknown[] {
  return [
    row.id,
    row.collection_id,
    row.owner_id,
    row.import_item_id,
    row.title,
    row.body,
    row.source_image_text,
    JSON.stringify(row.page_numbers ?? []),
    row.sort_order,
    householdId,
    toMs(row.updated_at),
    0,
  ];
}

function importBatchToParams(row: ImportBatchRow): readonly unknown[] {
  return [
    row.id,
    row.owner_id,
    row.name,
    row.batch_kind ?? 'STANDARD',
    row.source_kind,
    row.target_collection_id,
    row.default_model,
    row.default_provider,
    row.default_prompt ?? null,
    row.fallback_model,
    row.fallback_provider,
    row.key_owner_id ?? null,
    row.recitation_policy,
    row.status,
    row.total_items,
    row.is_planner ? 1 : 0,
    toMs(row.updated_at),
    0,
  ];
}

function importItemToParams(row: ImportItemRow): readonly unknown[] {
  const driftsText =
    row.parsed_drafts_json === null || row.parsed_drafts_json === undefined
      ? null
      : JSON.stringify(row.parsed_drafts_json);
  const createdIdsText = JSON.stringify(row.created_recipe_ids ?? []);
  const extrasText = JSON.stringify(row.extra_storage_paths ?? []);
  return [
    row.id,
    row.batch_id,
    row.owner_id,
    row.page_index,
    row.storage_path,
    row.thumb_path,
    row.source_pdf_path,
    row.source_pdf_page,
    row.assigned_collection_id,
    row.assigned_page_number,
    row.assigned_recipe_id ?? null,
    row.is_toc ? 1 : 0,
    row.kind ?? 'RECIPE',
    row.status,
    toMs(row.claim_expires_at),
    row.attempts,
    row.last_error,
    driftsText,
    row.model_used,
    row.prompt_tokens,
    row.completion_tokens,
    row.cost_usd_micros,
    createdIdsText,
    row.selected_variant_id ?? null,
    row.needs_fallback ? 1 : 0,
    extrasText,
    toMs(row.updated_at),
    0,
  ];
}

function importItemAttemptToParams(row: ImportItemAttemptRow): readonly unknown[] {
  return [
    row.id,
    row.item_id,
    row.owner_id,
    row.attempt_no,
    row.provider,
    row.model,
    row.raw_response_path,
    row.error_kind,
    row.error_message,
    row.prompt_tokens,
    row.completion_tokens,
    row.cost_usd_micros,
    row.latency_ms,
    toMs(row.started_at),
    row.finished_at ? toMs(row.finished_at) : null,
    toMs(row.finished_at ?? row.started_at),
    0,
  ];
}

function importTocEntryToParams(row: ImportTocEntryRow): readonly unknown[] {
  return [
    row.id,
    row.batch_id,
    row.item_id,
    row.owner_id,
    row.title,
    row.page_number,
    row.confidence,
    toMs(row.updated_at),
    0,
  ];
}

/**
 * Drop incoming rows the user deleted locally while this fetch was in
 * flight (a matching hard-delete still pending in the outbox).
 * `filterFresherIncoming` can't protect these — the local row is already
 * gone, so there's no fresher `updated_at` to win the compare — and without
 * this guard a stale pull response (or an INSERT echo) re-inserts the row
 * *permanently*: pulls only ever upsert, and the owner-filtered realtime
 * DELETE event never delivers (the old record carries just the PK), so
 * nothing would clean the zombie up again. Applies to the hard-delete
 * tables only; soft-deleted tables (recipes, collections) are covered by
 * their tombstone row winning the freshness compare.
 */
async function dropLocallyDeleted<T>(
  kind: OutboxKind,
  rows: T[],
  getId: (r: T) => string,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const deleted = await pendingDeleteIds(kind, rows.map(getId));
  if (deleted.size === 0) return rows;
  return rows.filter((r) => !deleted.has(getId(r)));
}

async function pullConversionRules(
  client: CookbooksClient,
  ownerId: string,
): Promise<number> {
  const topic = `conversion_rules:${ownerId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<ConversionRuleRow>((from, to) =>
    client
      .from('conversion_rules')
      .select('*')
      .eq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await dropLocallyDeleted(
      'conversion_rule_delete',
      await filterFresherIncoming(
        'conversion_rules',
        rows,
        (r) => r.id,
        (r) => toMs(r.updated_at),
      ),
      (r) => r.id,
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['conversion_rules'], fresh.length, () =>
        bulkInsertOnConflictId(
          'conversion_rules',
          CONVERSION_RULE_COLS,
          fresh,
          conversionRuleToParams,
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

async function pullRewriteJobs(
  client: CookbooksClient,
  ownerId: string,
): Promise<number> {
  const topic = `rewrite_jobs:${ownerId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<RewriteJobRow>((from, to) =>
    client
      .from('rewrite_jobs')
      .select('*')
      .eq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await filterFresherIncoming(
      'rewrite_jobs',
      rows,
      (r) => r.id,
      (r) => toMs(r.updated_at),
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['rewrite_jobs'], fresh.length, () =>
        bulkInsertOnConflictId(
          'rewrite_jobs',
          REWRITE_JOB_COLS,
          fresh,
          rewriteJobToParams,
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

async function pullRemixJobs(
  client: CookbooksClient,
  ownerId: string,
): Promise<number> {
  const topic = `remix_jobs:${ownerId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<RemixJobRow>((from, to) =>
    client
      .from('remix_jobs')
      // input_recipe_json / household_id come back too but aren't mirrored
      // locally — REMIX_JOB_COLS + remixJobToParams pick only what we store.
      .select('*')
      .eq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await filterFresherIncoming(
      'remix_jobs',
      rows,
      (r) => r.id,
      (r) => toMs(r.updated_at),
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['remix_jobs'], fresh.length, () =>
        bulkInsertOnConflictId(
          'remix_jobs',
          REMIX_JOB_COLS,
          fresh,
          remixJobToParams,
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

// ---------- pull: recipe embeddings ----------

/**
 * Postgres `vector(N)` round-trips through PostgREST as a string like
 * "[0.123,-0.456,...]" by default. Some deployments cast it to a
 * numeric array. Tolerate both: if we already got an array, just
 * convert numbers; otherwise parse the JSON-ish bracketed form.
 */
function decodeVector(raw: number[] | string | null | undefined): Float32Array | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return Float32Array.from(raw);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return Float32Array.from(parsed as number[]);
    } catch {
      // Fall through; pgvector text format is always JSON-array shape,
      // so a parse failure means something else broke.
    }
  }
  return null;
}

async function pullRecipeEmbeddings(
  client: CookbooksClient,
  ownerId: string,
): Promise<number> {
  const topic = `recipe_embeddings:${ownerId}`;
  // Keyset by (updated_at, recipe_id), not OFFSET. recipe_embeddings carries a
  // denormalized owner_id (20260624000000) so we filter on it directly, but the
  // OFFSET pull seq-scanned + sorted the owner's whole vector set per page (no
  // supporting index) and blew the 8s statement timeout on a full re-pull's
  // deep pages — 57014 (CYB-CAPACITOR-A), which also stalled the whole pull
  // into the 45s sync timeout. Backed by recipe_embeddings_owner_pull_idx
  // (20260626000400) so each page is an O(PAGE_SIZE) index range scan.
  // Existing topics carry only the legacy ms watermark (empty keyset cursor),
  // so they full-pull once here and re-establish a clean (ts, recipe_id) cursor.
  const start = await getRecipeCursor(topic);
  const rows = await fetchAllByUpdatedKeyset<RecipeEmbeddingRow>(
    (cur) => {
      let q = client.from('recipe_embeddings').select('*').eq('owner_id', ownerId);
      if (cur.id !== '') q = q.or(updatedKeysetOr(cur, 'recipe_id'));
      return q
        .order('updated_at', { ascending: true })
        .order('recipe_id', { ascending: true })
        .limit(PAGE_SIZE);
    },
    start,
    (r) => r.recipe_id,
  );
  await applyPulledEmbeddings(rows);
  const next = maxCursor(
    rows.map((r) => ({ updated_at: r.updated_at, id: r.recipe_id })),
    start,
  );
  if (next.ts) await setRecipeCursor(topic, next);
  return rows.length;
}

/**
 * Co-members' embeddings — filtered by our household_id (+ owner_id <> me),
 * indexed and join-free, exactly like the household recipe pull. The
 * claim-based recipe_embeddings RLS (20260624000000) confirms read access.
 * This is what makes household-shared recipes semantically searchable:
 * their vectors land in the same local mirror, and listSearchableEmbeddings
 * surfaces them via the collection's shared_with_household_id marker.
 * Watermarked per-household so switching households forces a fresh pull.
 */
async function pullHouseholdEmbeddings(
  client: CookbooksClient,
  ownerId: string,
  householdId: string,
): Promise<number> {
  const topic = `household_embeddings:${ownerId}:${householdId}`;
  // Keyset like the owner pull — backed by recipe_embeddings_household_pull_idx
  // (20260626000400). resetHouseholdWatermarks deletes this whole sync_state
  // row, so a household change still forces a clean full re-pull from an empty
  // keyset cursor.
  const start = await getRecipeCursor(topic);
  const rows = await fetchAllByUpdatedKeyset<RecipeEmbeddingRow>(
    (cur) => {
      let q = client
        .from('recipe_embeddings')
        .select('*')
        .eq('household_id', householdId)
        .neq('owner_id', ownerId);
      if (cur.id !== '') q = q.or(updatedKeysetOr(cur, 'recipe_id'));
      return q
        .order('updated_at', { ascending: true })
        .order('recipe_id', { ascending: true })
        .limit(PAGE_SIZE);
    },
    start,
    (r) => r.recipe_id,
  );
  await applyPulledEmbeddings(rows);
  const next = maxCursor(
    rows.map((r) => ({ updated_at: r.updated_at, id: r.recipe_id })),
    start,
  );
  if (next.ts) await setRecipeCursor(topic, next);
  return rows.length;
}

/** Decode pulled pgvector rows and upsert them into the local mirror. */
async function applyPulledEmbeddings(rows: RecipeEmbeddingRow[]): Promise<void> {
  const local: LocalEmbeddingRow[] = [];
  for (const r of rows) {
    const vec = decodeVector(r.embedding);
    if (!vec) continue;
    local.push({
      recipeId: r.recipe_id,
      embedding: vec,
      textHash: r.text_hash,
      model: r.model,
      updatedAtMs: toMs(r.updated_at),
    });
  }
  await upsertLocalEmbeddingsBatch(local);
}

// ---------- pull: cooking tracker ----------

async function pullCookingEvents(
  client: CookbooksClient,
  ownerId: string,
): Promise<number> {
  const topic = `cooking_events:${ownerId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<CookingEventRow>((from, to) =>
    client
      .from('cooking_events')
      .select('*')
      .eq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await dropLocallyDeleted(
      'cooking_event_delete',
      await filterFresherIncoming(
        'cooking_events',
        rows,
        (r) => r.id,
        (r) => toMs(r.updated_at),
      ),
      (r) => r.id,
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['cooking_events'], fresh.length, () =>
        bulkInsertOnConflictId('cooking_events', COOKING_EVENT_COLS, fresh, (r) =>
          cookingEventToParams(r, null),
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

async function pullRecipeTags(
  client: CookbooksClient,
  ownerId: string,
): Promise<number> {
  const topic = `recipe_tags:${ownerId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<RecipeTagRow>((from, to) =>
    client
      .from('recipe_tags')
      .select('*')
      .eq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await dropLocallyDeleted(
      'recipe_tag_delete',
      await filterFresherIncoming(
        'recipe_tags',
        rows,
        (r) => r.id,
        (r) => toMs(r.updated_at),
      ),
      (r) => r.id,
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['recipe_tags'], fresh.length, () =>
        bulkInsertOnConflictId('recipe_tags', RECIPE_TAG_COLS, fresh, (r) =>
          recipeTagToParams(r, null),
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

// Co-members' cooking events / tags — filtered by household_id = our
// household (+ owner_id <> me), tagged locally with shared_with_household_id
// so the repository surfaces them. Watermarked per-household so switching
// households forces a fresh pull.
async function pullHouseholdCookingEvents(
  client: CookbooksClient,
  ownerId: string,
  householdId: string,
): Promise<number> {
  const topic = `household_cooking_events:${ownerId}:${householdId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<CookingEventRow>((from, to) =>
    client
      .from('cooking_events')
      .select('*')
      .eq('household_id', householdId)
      .neq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await filterFresherIncoming(
      'cooking_events',
      rows,
      (r) => r.id,
      (r) => toMs(r.updated_at),
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['cooking_events'], fresh.length, () =>
        bulkInsertOnConflictId('cooking_events', COOKING_EVENT_COLS, fresh, (r) =>
          cookingEventToParams(r, householdId),
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

async function pullHouseholdRecipeTags(
  client: CookbooksClient,
  ownerId: string,
  householdId: string,
): Promise<number> {
  const topic = `household_recipe_tags:${ownerId}:${householdId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<RecipeTagRow>((from, to) =>
    client
      .from('recipe_tags')
      .select('*')
      .eq('household_id', householdId)
      .neq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await filterFresherIncoming(
      'recipe_tags',
      rows,
      (r) => r.id,
      (r) => toMs(r.updated_at),
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['recipe_tags'], fresh.length, () =>
        bulkInsertOnConflictId('recipe_tags', RECIPE_TAG_COLS, fresh, (r) =>
          recipeTagToParams(r, householdId),
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

async function pullCollectionNotes(
  client: CookbooksClient,
  ownerId: string,
): Promise<number> {
  const topic = `collection_notes:${ownerId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<CollectionNoteRow>((from, to) =>
    client
      .from('collection_notes')
      .select('*')
      .eq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await dropLocallyDeleted(
      'collection_note_delete',
      await filterFresherIncoming(
        'collection_notes',
        rows,
        (r) => r.id,
        (r) => toMs(r.updated_at),
      ),
      (r) => r.id,
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['collection_notes'], fresh.length, () =>
        bulkInsertOnConflictId('collection_notes', COLLECTION_NOTE_COLS, fresh, (r) =>
          collectionNoteToParams(r, null),
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

async function pullHouseholdCollectionNotes(
  client: CookbooksClient,
  ownerId: string,
  householdId: string,
): Promise<number> {
  const topic = `household_collection_notes:${ownerId}:${householdId}`;
  const since = new Date(await getWatermark(topic)).toISOString();
  const rows = await fetchAllPages<CollectionNoteRow>((from, to) =>
    client
      .from('collection_notes')
      .select('*')
      .eq('household_id', householdId)
      .neq('owner_id', ownerId)
      .gte('updated_at', since)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (rows.length > 0) {
    const fresh = await filterFresherIncoming(
      'collection_notes',
      rows,
      (r) => r.id,
      (r) => toMs(r.updated_at),
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['collection_notes'], fresh.length, () =>
        bulkInsertOnConflictId('collection_notes', COLLECTION_NOTE_COLS, fresh, (r) =>
          collectionNoteToParams(r, householdId),
        ),
      );
    }
  }
  let max = await getWatermark(topic);
  for (const row of rows) max = Math.max(max, toMs(row.updated_at));
  if (max > 0) await bumpWatermark(topic, max);
  return rows.length;
}

// ---------- pull: bulk OCR imports ----------

interface ImportPullCounts {
  batches: number;
  items: number;
  attempts: number;
  tocEntries: number;
}

async function pullImports(
  client: CookbooksClient,
  ownerId: string,
): Promise<ImportPullCounts> {
  // Fetch all four import topics in parallel — independent network
  // requests, no FK dependencies, so the slowest is the bottleneck
  // instead of the sum.
  const batchTopic = `import_batches:${ownerId}`;
  const itemTopic = `import_items:${ownerId}`;
  const attemptTopic = `import_item_attempts:${ownerId}`;
  const tocTopic = `import_toc_entries:${ownerId}`;
  const [batchSinceMs, itemSinceMs, attemptSinceMs, tocSinceMs] = await Promise.all([
    getWatermark(batchTopic),
    getWatermark(itemTopic),
    getWatermark(attemptTopic),
    getWatermark(tocTopic),
  ]);
  const [batches, items, attempts, tocs] = await Promise.all([
    fetchAllPages<ImportBatchRow>((from, to) =>
      client
        .from('import_batches')
        .select('*')
        .eq('owner_id', ownerId)
        .gte('updated_at', new Date(batchSinceMs).toISOString())
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<ImportItemRow>((from, to) =>
      client
        .from('import_items')
        .select('*')
        .eq('owner_id', ownerId)
        .gte('updated_at', new Date(itemSinceMs).toISOString())
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<ImportItemAttemptRow>((from, to) =>
      client
        .from('import_item_attempts')
        .select('*')
        .eq('owner_id', ownerId)
        .gte('started_at', new Date(attemptSinceMs).toISOString())
        .order('started_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<ImportTocEntryRow>((from, to) =>
      client
        .from('import_toc_entries')
        .select('*')
        .eq('owner_id', ownerId)
        .gte('updated_at', new Date(tocSinceMs).toISOString())
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);

  // One trigger-suspension covers all four tables. Bulk INSERTs run
  // serially under the SQLite mutex, but they're now ⌈N/chunk⌉
  // statements instead of N.
  await withSuppressedCrrTriggers(
    ['import_batches', 'import_items', 'import_item_attempts', 'import_toc_entries'],
    batches.length + items.length + attempts.length + tocs.length,
    async () => {
      if (batches.length > 0) {
        const fresh = await filterFresherIncoming(
          'import_batches',
          batches,
          (r) => r.id,
          (r) => toMs(r.updated_at),
        );
        await bulkInsertOnConflictId(
          'import_batches',
          IMPORT_BATCH_COLS,
          fresh,
          importBatchToParams,
        );
      }
      if (items.length > 0) {
        const fresh = await filterFresherIncoming(
          'import_items',
          items,
          (r) => r.id,
          (r) => toMs(r.updated_at),
        );
        await bulkInsertOnConflictId(
          'import_items',
          IMPORT_ITEM_COLS,
          fresh,
          importItemToParams,
        );
      }
      if (attempts.length > 0) {
        // Append-only on the server — local upsert tolerates re-arrival
        // with `on conflict do nothing` since attempt rows are immutable.
        await bulkInsertIgnoreId(
          'import_item_attempts',
          IMPORT_ITEM_ATTEMPT_COLS,
          attempts,
          importItemAttemptToParams,
        );
      }
      if (tocs.length > 0) {
        const fresh = await filterFresherIncoming(
          'import_toc_entries',
          tocs,
          (r) => r.id,
          (r) => toMs(r.updated_at),
        );
        await bulkInsertOnConflictId(
          'import_toc_entries',
          IMPORT_TOC_COLS,
          fresh,
          importTocEntryToParams,
        );
      }
    },
  );

  // Bump watermarks (in parallel — independent rows in sync_state).
  let maxBatchTs = batchSinceMs;
  for (const r of batches) maxBatchTs = Math.max(maxBatchTs, toMs(r.updated_at));
  let maxItemTs = itemSinceMs;
  for (const r of items) maxItemTs = Math.max(maxItemTs, toMs(r.updated_at));
  let maxAttemptTs = attemptSinceMs;
  for (const r of attempts) maxAttemptTs = Math.max(maxAttemptTs, toMs(r.started_at));
  let maxTocTs = tocSinceMs;
  for (const r of tocs) maxTocTs = Math.max(maxTocTs, toMs(r.updated_at));
  await Promise.all([
    maxBatchTs > 0 ? bumpWatermark(batchTopic, maxBatchTs) : Promise.resolve(),
    maxItemTs > 0 ? bumpWatermark(itemTopic, maxItemTs) : Promise.resolve(),
    maxAttemptTs > 0 ? bumpWatermark(attemptTopic, maxAttemptTs) : Promise.resolve(),
    maxTocTs > 0 ? bumpWatermark(tocTopic, maxTocTs) : Promise.resolve(),
  ]);

  return {
    batches: batches.length,
    items: items.length,
    attempts: attempts.length,
    tocEntries: tocs.length,
  };
}

// ---------- local upserts for import rows ----------

async function upsertImportBatchRow(row: ImportBatchRow): Promise<void> {
  const db = await getLocalDb();
  const ts = toMs(row.updated_at);
  await db.exec(
    `insert into import_batches
       (id, owner_id, name, batch_kind, source_kind, target_collection_id,
        default_model, default_provider, fallback_model, fallback_provider,
        recitation_policy, status, total_items, is_planner, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       name=excluded.name,
       batch_kind=excluded.batch_kind,
       source_kind=excluded.source_kind,
       target_collection_id=excluded.target_collection_id,
       default_model=excluded.default_model,
       default_provider=excluded.default_provider,
       fallback_model=excluded.fallback_model,
       fallback_provider=excluded.fallback_provider,
       recitation_policy=excluded.recitation_policy,
       status=excluded.status,
       total_items=excluded.total_items,
       is_planner=excluded.is_planner,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= import_batches.updated_at`,
    [
      row.id,
      row.owner_id,
      row.name,
      row.batch_kind ?? 'STANDARD',
      row.source_kind,
      row.target_collection_id,
      row.default_model,
      row.default_provider,
      row.fallback_model,
      row.fallback_provider,
      row.recitation_policy,
      row.status,
      row.total_items,
      row.is_planner ? 1 : 0,
      ts,
    ],
  );
}

async function upsertImportItemRow(row: ImportItemRow): Promise<void> {
  const db = await getLocalDb();
  const ts = toMs(row.updated_at);
  // parsed_drafts and created_recipe_ids round-trip through JSON text in
  // SQLite. supabase-js gives us live arrays / objects.
  const driftsText = row.parsed_drafts_json === null || row.parsed_drafts_json === undefined
    ? null
    : JSON.stringify(row.parsed_drafts_json);
  const createdIdsText = JSON.stringify(row.created_recipe_ids ?? []);
  const extrasText = JSON.stringify(row.extra_storage_paths ?? []);
  await db.exec(
    `insert into import_items
       (id, batch_id, owner_id, page_index, storage_path, thumb_path,
        source_pdf_path, source_pdf_page,
        assigned_collection_id, assigned_page_number, assigned_recipe_id,
        is_toc, kind, status, claim_expires_at, attempts, last_error,
        parsed_drafts_json, model_used, prompt_tokens, completion_tokens,
        cost_usd_micros, created_recipe_ids, selected_variant_id,
        needs_fallback, extra_storage_paths, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       batch_id=excluded.batch_id,
       owner_id=excluded.owner_id,
       page_index=excluded.page_index,
       storage_path=excluded.storage_path,
       thumb_path=excluded.thumb_path,
       source_pdf_path=excluded.source_pdf_path,
       source_pdf_page=excluded.source_pdf_page,
       assigned_collection_id=excluded.assigned_collection_id,
       assigned_page_number=excluded.assigned_page_number,
       assigned_recipe_id=excluded.assigned_recipe_id,
       is_toc=excluded.is_toc,
       kind=excluded.kind,
       status=excluded.status,
       claim_expires_at=excluded.claim_expires_at,
       attempts=excluded.attempts,
       last_error=excluded.last_error,
       parsed_drafts_json=excluded.parsed_drafts_json,
       model_used=excluded.model_used,
       prompt_tokens=excluded.prompt_tokens,
       completion_tokens=excluded.completion_tokens,
       cost_usd_micros=excluded.cost_usd_micros,
       created_recipe_ids=excluded.created_recipe_ids,
       selected_variant_id=excluded.selected_variant_id,
       needs_fallback=excluded.needs_fallback,
       extra_storage_paths=excluded.extra_storage_paths,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= import_items.updated_at`,
    [
      row.id,
      row.batch_id,
      row.owner_id,
      row.page_index,
      row.storage_path,
      row.thumb_path,
      row.source_pdf_path,
      row.source_pdf_page,
      row.assigned_collection_id,
      row.assigned_page_number,
      row.assigned_recipe_id ?? null,
      row.is_toc ? 1 : 0,
      row.kind ?? 'RECIPE',
      row.status,
      toMs(row.claim_expires_at),
      row.attempts,
      row.last_error,
      driftsText,
      row.model_used,
      row.prompt_tokens,
      row.completion_tokens,
      row.cost_usd_micros,
      createdIdsText,
      row.selected_variant_id ?? null,
      row.needs_fallback ? 1 : 0,
      extrasText,
      ts,
    ],
  );
}

async function upsertImportItemAttemptRow(row: ImportItemAttemptRow): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into import_item_attempts
       (id, item_id, owner_id, attempt_no, provider, model,
        raw_response_path, error_kind, error_message,
        prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
        started_at, finished_at, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       item_id=excluded.item_id,
       owner_id=excluded.owner_id,
       attempt_no=excluded.attempt_no,
       provider=excluded.provider,
       model=excluded.model,
       raw_response_path=excluded.raw_response_path,
       error_kind=excluded.error_kind,
       error_message=excluded.error_message,
       prompt_tokens=excluded.prompt_tokens,
       completion_tokens=excluded.completion_tokens,
       cost_usd_micros=excluded.cost_usd_micros,
       latency_ms=excluded.latency_ms,
       started_at=excluded.started_at,
       finished_at=excluded.finished_at,
       updated_at=excluded.updated_at`,
    [
      row.id,
      row.item_id,
      row.owner_id,
      row.attempt_no,
      row.provider,
      row.model,
      row.raw_response_path,
      row.error_kind,
      row.error_message,
      row.prompt_tokens,
      row.completion_tokens,
      row.cost_usd_micros,
      row.latency_ms,
      toMs(row.started_at),
      row.finished_at ? toMs(row.finished_at) : null,
      toMs(row.finished_at ?? row.started_at),
    ],
  );
}

async function upsertConversionRuleRow(row: ConversionRuleRow): Promise<void> {
  const db = await getLocalDb();
  const ts = toMs(row.updated_at);
  await db.exec(
    `insert into conversion_rules
       (id, owner_id, recipe_id, from_unit, to_unit, factor, ingredient_name,
        notes, priority, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       recipe_id=excluded.recipe_id,
       from_unit=excluded.from_unit,
       to_unit=excluded.to_unit,
       factor=excluded.factor,
       ingredient_name=excluded.ingredient_name,
       notes=excluded.notes,
       priority=excluded.priority,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= conversion_rules.updated_at`,
    [
      row.id,
      row.owner_id,
      row.recipe_id,
      row.from_unit,
      row.to_unit,
      row.factor,
      row.ingredient_name,
      row.notes,
      row.priority,
      ts,
    ],
  );
}

async function upsertRewriteJobRow(row: RewriteJobRow): Promise<void> {
  const db = await getLocalDb();
  const ts = toMs(row.updated_at);
  const resultText = row.result_json === null || row.result_json === undefined
    ? null
    : JSON.stringify(row.result_json);
  await db.exec(
    `insert into rewrite_jobs
       (id, owner_id, recipe_id, status, provider, model, prompt,
        claim_expires_at, attempts, last_error, result_json,
        prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
        updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       recipe_id=excluded.recipe_id,
       status=excluded.status,
       provider=excluded.provider,
       model=excluded.model,
       prompt=excluded.prompt,
       claim_expires_at=excluded.claim_expires_at,
       attempts=excluded.attempts,
       last_error=excluded.last_error,
       result_json=excluded.result_json,
       prompt_tokens=excluded.prompt_tokens,
       completion_tokens=excluded.completion_tokens,
       cost_usd_micros=excluded.cost_usd_micros,
       latency_ms=excluded.latency_ms,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= rewrite_jobs.updated_at`,
    [
      row.id,
      row.owner_id,
      row.recipe_id,
      row.status,
      row.provider,
      row.model,
      row.prompt,
      toMs(row.claim_expires_at),
      row.attempts,
      row.last_error,
      resultText,
      row.prompt_tokens,
      row.completion_tokens,
      row.cost_usd_micros,
      row.latency_ms,
      ts,
    ],
  );
}

async function upsertRemixJobRow(row: RemixJobRow): Promise<void> {
  const db = await getLocalDb();
  const ts = toMs(row.updated_at);
  const resultText = row.result_json === null || row.result_json === undefined
    ? null
    : JSON.stringify(row.result_json);
  await db.exec(
    `insert into remix_jobs
       (id, owner_id, recipe_id, status, provider, model, prompt, instruction,
        claim_expires_at, attempts, last_error, result_json,
        prompt_tokens, completion_tokens, cost_usd_micros, latency_ms,
        updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       recipe_id=excluded.recipe_id,
       status=excluded.status,
       provider=excluded.provider,
       model=excluded.model,
       prompt=excluded.prompt,
       instruction=excluded.instruction,
       claim_expires_at=excluded.claim_expires_at,
       attempts=excluded.attempts,
       last_error=excluded.last_error,
       result_json=excluded.result_json,
       prompt_tokens=excluded.prompt_tokens,
       completion_tokens=excluded.completion_tokens,
       cost_usd_micros=excluded.cost_usd_micros,
       latency_ms=excluded.latency_ms,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= remix_jobs.updated_at`,
    [
      row.id,
      row.owner_id,
      row.recipe_id,
      row.status,
      row.provider,
      row.model,
      // `prompt` holds the (large) remix system prompt, so Postgres TOASTs
      // it. Realtime UPDATE payloads omit unchanged TOASTed columns, so
      // `prompt`/`instruction` can be absent on CLAIMED/DONE events — coalesce
      // so the local NOT NULL columns don't reject the upsert. We never read
      // these locally; result_json (always present on the DONE update because
      // it changed) is what the dialog promotes.
      row.prompt ?? '',
      row.instruction ?? '',
      toMs(row.claim_expires_at),
      row.attempts,
      row.last_error,
      resultText,
      row.prompt_tokens,
      row.completion_tokens,
      row.cost_usd_micros,
      row.latency_ms,
      ts,
    ],
  );
}

async function upsertImportTocEntryRow(row: ImportTocEntryRow): Promise<void> {
  const db = await getLocalDb();
  const ts = toMs(row.updated_at);
  await db.exec(
    `insert into import_toc_entries
       (id, batch_id, item_id, owner_id, title, page_number, confidence, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       batch_id=excluded.batch_id,
       item_id=excluded.item_id,
       owner_id=excluded.owner_id,
       title=excluded.title,
       page_number=excluded.page_number,
       confidence=excluded.confidence,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= import_toc_entries.updated_at`,
    [
      row.id,
      row.batch_id,
      row.item_id,
      row.owner_id,
      row.title,
      row.page_number,
      row.confidence,
      ts,
    ],
  );
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = out.get(k);
    if (arr) arr.push(item);
    else out.set(k, [item]);
  }
  return out;
}

// ---------- realtime ----------

export interface RealtimeHandle {
  unsubscribe: () => Promise<void>;
}

export interface RealtimeCallbacks {
  /** Row already upserted locally — refresh UI only. */
  onLocalUpdate: () => void;
  /** Child row changed without local upsert — schedule a pull. */
  onNeedsPull: () => void;
  /**
   * Household membership / co-member sharing changed — reset the household
   * watermark and re-pull in full (a fresh share's back-catalog has old
   * updated_at the incremental watermark would skip). Falls back to
   * onNeedsPull when not provided.
   */
  onHouseholdChanged?: () => void;
}

export function subscribeRealtime(
  client: CookbooksClient,
  ownerId: string,
  callbacks: RealtimeCallbacks,
  householdId?: string | null,
): RealtimeHandle {
  const { onLocalUpdate, onNeedsPull } = callbacks;
  const channel: RealtimeChannel = client
    .channel(`cyb:${ownerId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipe_collections', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleCollectionEvent(payload);
        onLocalUpdate();
      },
    )
    // INSERT/UPDATE of our OWN recipes -> debounced bulk pull (the pull
    // fetches exactly the changed recipes + their children). Filtered by the
    // denormalized owner_id so a *public* recipe edited by anyone else no
    // longer RLS-broadcasts to — and wakes a pull on — every connected
    // client. DELETE is a separate, UNfiltered binding: under default replica
    // identity a DELETE payload carries only the PK, so an owner_id filter
    // would drop it and the local purge (which never arrives via a watermark
    // pull) would be missed.
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'recipes', filter: `owner_id=eq.${ownerId}` },
      () => onNeedsPull(),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'recipes', filter: `owner_id=eq.${ownerId}` },
      () => onNeedsPull(),
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'recipes' },
      async (payload) => {
        const id = ((payload as RealtimePayload).old as { id?: string }).id;
        if (id) await purgeRecipe(id);
        onLocalUpdate();
      },
    )
    // Children carry owner_id now, so scope these to our own rows. A
    // co-member's / public child edit reaches us via the household path or
    // the recipe event, not a platform-wide broadcast. (Own-child DELETEs
    // aren't needed here — a child delete rides the parent recipe's save,
    // which fires the UPDATE above.)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ingredients', filter: `owner_id=eq.${ownerId}` },
      () => onNeedsPull(),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'instructions', filter: `owner_id=eq.${ownerId}` },
      () => onNeedsPull(),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'import_batches', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleImportBatchEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'import_items', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleImportItemEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'import_item_attempts', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleImportAttemptEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'import_toc_entries', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleImportTocEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'conversion_rules', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleConversionRuleEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'rewrite_jobs', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleRewriteJobEvent(payload);
        // A DONE job means the worker just wrote `simplified_steps` to
        // one or more instructions rows. Trigger a recipe refetch so the
        // user sees the new steps without waiting for the next pull.
        const evt = payload.new as { status?: string } | undefined;
        if (evt?.status === 'DONE') onNeedsPull();
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'remix_jobs', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        // Unlike rewrite, remix writes nothing to the recipe tables — the
        // client promotes the draft itself — so a local update (which
        // advances the useRemixJob poll) is enough; no onNeedsPull().
        await handleRemixJobEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipe_embeddings' },
      async (payload) => {
        await handleRecipeEmbeddingEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'cooking_events', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleCookingEventEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipe_tags', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleRecipeTagEvent(payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'collection_notes', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleCollectionNoteEvent(payload);
        onLocalUpdate();
      },
    );

  // Household library sharing is membership-driven, so there's no
  // per-collection flag to filter realtime on. Instead, watch all
  // recipe_collections changes (RLS only lets co-members' rows through)
  // and schedule a household re-pull — that re-applies the local marker
  // and fetches any new recipes by watermark. The owner-filtered
  // subscription above already handles our own rows; the duplicate
  // events on our own collections are idempotent.
  if (householdId) {
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'recipe_collections',
        // Only OTHER members' collection changes need a household re-pull;
        // our own rows are already handled by the owner-filtered
        // subscription above. Without this, every own-collection edit also
        // scheduled a redundant full cycle.
        filter: `owner_id=neq.${ownerId}`,
      },
      () => {
        onNeedsPull();
      },
    );
    // Co-members' recipe INSERT/UPDATE: their shared recipes carry our
    // household_id, so this delivers their edits in ~realtime (the
    // owner-filtered binding above is scoped to us) without the
    // public-content fan-out an unfiltered binding would cause. The
    // incremental household pull — also household_id-scoped — fetches them.
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipes', filter: `household_id=eq.${householdId}` },
      () => {
        onNeedsPull();
      },
    );
    // Membership churn (someone joined or left) doesn't change recipe
    // data immediately but it changes which collections we can see, so
    // schedule a pull on any household_members change for our household.
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'household_members',
        filter: `household_id=eq.${householdId}`,
      },
      () => {
        // Membership / sharing change: reset the household watermark and
        // re-pull in full so a fresh share's back-catalog (old updated_at)
        // surfaces, not just rows newer than the watermark.
        (callbacks.onHouseholdChanged ?? onNeedsPull)();
      },
    );
    // Co-members' cooking activity + tags. Like recipe_collections above,
    // RLS only delivers other members' rows here; schedule a household
    // re-pull so the local shared_with_household_id marker is reapplied.
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'cooking_events', filter: `owner_id=neq.${ownerId}` },
      () => {
        onNeedsPull();
      },
    );
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipe_tags', filter: `owner_id=neq.${ownerId}` },
      () => {
        onNeedsPull();
      },
    );
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'collection_notes', filter: `owner_id=neq.${ownerId}` },
      () => {
        onNeedsPull();
      },
    );
  }

  channel.subscribe();

  return {
    unsubscribe: async () => {
      await client.removeChannel(channel);
    },
  };
}

type RealtimePayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

async function handleCollectionEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) await purgeCollection(id);
    return;
  }
  const row = payload.new as CollectionRow;
  await upsertCollectionRow(row);
}

async function handleImportBatchEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from import_batches where id = ?`, [id]);
    }
    return;
  }
  await upsertImportBatchRow(payload.new as unknown as ImportBatchRow);
}

async function handleImportItemEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from import_items where id = ?`, [id]);
    }
    return;
  }
  await upsertImportItemRow(payload.new as unknown as ImportItemRow);
}

async function handleImportAttemptEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from import_item_attempts where id = ?`, [id]);
    }
    return;
  }
  await upsertImportItemAttemptRow(payload.new as unknown as ImportItemAttemptRow);
}

async function handleImportTocEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from import_toc_entries where id = ?`, [id]);
    }
    return;
  }
  await upsertImportTocEntryRow(payload.new as unknown as ImportTocEntryRow);
}

async function handleConversionRuleEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from conversion_rules where id = ?`, [id]);
    }
    return;
  }
  const row = payload.new as unknown as ConversionRuleRow;
  // Don't let our own INSERT echo resurrect a row deleted locally while the
  // event was in flight — see dropLocallyDeleted.
  if ((await pendingDeleteIds('conversion_rule_delete', [row.id])).size > 0) return;
  await upsertConversionRuleRow(row);
}

async function handleRewriteJobEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from rewrite_jobs where id = ?`, [id]);
    }
    return;
  }
  await upsertRewriteJobRow(payload.new as unknown as RewriteJobRow);
}

async function handleRemixJobEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from remix_jobs where id = ?`, [id]);
    }
    return;
  }
  await upsertRemixJobRow(payload.new as unknown as RemixJobRow);
}

async function handleRecipeEmbeddingEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { recipe_id?: string }).recipe_id;
    if (id) await deleteLocalEmbedding(id);
    return;
  }
  const row = payload.new as unknown as RecipeEmbeddingRow;
  const vec = decodeVector(row.embedding);
  if (!vec) return;
  await upsertLocalEmbedding({
    recipeId: row.recipe_id,
    embedding: vec,
    textHash: row.text_hash,
    model: row.model,
    updatedAtMs: toMs(row.updated_at),
  });
}

async function handleCookingEventEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from cooking_events where id = ?`, [id]);
    }
    return;
  }
  const row = payload.new as unknown as CookingEventRow;
  if ((await pendingDeleteIds('cooking_event_delete', [row.id])).size > 0) return;
  await upsertCookingEventRow(row);
}

async function handleRecipeTagEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from recipe_tags where id = ?`, [id]);
    }
    return;
  }
  const row = payload.new as unknown as RecipeTagRow;
  if ((await pendingDeleteIds('recipe_tag_delete', [row.id])).size > 0) return;
  await upsertRecipeTagRow(row);
}

async function handleCollectionNoteEvent(payload: RealtimePayload): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) {
      const db = await getLocalDb();
      await db.exec(`delete from collection_notes where id = ?`, [id]);
    }
    return;
  }
  const row = payload.new as unknown as CollectionNoteRow;
  if ((await pendingDeleteIds('collection_note_delete', [row.id])).size > 0) return;
  await upsertCollectionNoteRow(row);
}

// ---------- push ----------

export async function pushOutbox(
  client: CookbooksClient,
  ownerId: string,
  signal?: AbortSignal,
): Promise<{ ok: number; failed: number }> {
  logSync('info', 'pushOutbox: entered');
  const pending = await listPending();
  logSync('info', `push: ${pending.length} pending`, {
    kinds: summarizeKinds(pending),
  });
  let ok = 0;
  let failed = 0;
  let i = 0;
  while (i < pending.length) {
    if (signal?.aborted) {
      logSync('warn', `pushOutbox: aborted at index ${i}/${pending.length}`);
      break;
    }
    const entry = pending[i]!;
    // Coalesce a contiguous run of import_item_insert entries into a
    // single chunked bulk upsert. 200-page uploads otherwise mean 200
    // sequential PostgREST round-trips, which trip the cycle timeout.
    if (entry.kind === 'import_item_insert') {
      let j = i;
      while (j < pending.length && pending[j]!.kind === 'import_item_insert') j += 1;
      const run = pending.slice(i, j);
      const started = Date.now();
      logSync('info', `push import_item_insert run: ${run.length} items`);
      try {
        await pushImportItemsBulk(
          client,
          run.map((e) => e.entity_id),
        );
        for (const e of run) await markDone(e.id);
        ok += run.length;
        logSync('info', `push import_item_insert done in ${Date.now() - started}ms`, {
          count: run.length,
        });
        i = j;
        continue;
      } catch (err) {
        // Attribute the failure to the first entry so its attempts/error
        // surface in the UI; leave the rest queued for the next cycle.
        const msg = (err as Error).message;
        await markFailed(run[0]!.id, msg);
        failed += 1;
        logSync('error', `push import_item_insert FAILED after ${Date.now() - started}ms`, {
          count: run.length,
          error: msg,
        });
        reportError(err, {
          operation: 'push',
          tags: { kind: 'import_item_insert' },
          extra: { count: run.length },
        });
        break;
      }
    }
    // Coalesce a contiguous run of recipe_save entries into chunked
    // transactional RPC calls. Each recipe used to cost 6 sequential
    // PostgREST round-trips; a large ToC approval enqueues dozens, which
    // never drained inside the cycle timeout. See save_recipes_graph.
    if (entry.kind === 'recipe_save') {
      let j = i;
      while (j < pending.length && pending[j]!.kind === 'recipe_save') j += 1;
      const run = pending.slice(i, j);
      const started = Date.now();
      logSync('info', `push recipe_save run: ${run.length} items`);
      try {
        await pushRecipeSavesRun(client, run);
        for (const e of run) await markDone(e.id);
        ok += run.length;
        logSync('info', `push recipe_save done in ${Date.now() - started}ms`, {
          count: run.length,
        });
        i = j;
        continue;
      } catch (err) {
        // Attribute to the first entry so its attempts/error surface; the
        // whole run stays queued and re-pushes idempotently next cycle.
        const msg = (err as Error).message;
        await markFailed(run[0]!.id, msg);
        failed += 1;
        logSync('error', `push recipe_save run FAILED after ${Date.now() - started}ms`, {
          count: run.length,
          error: msg,
        });
        // This is where a save_recipes_graph statement timeout surfaces.
        reportError(err, {
          operation: 'push',
          tags: { kind: 'recipe_save' },
          extra: { count: run.length },
        });
        break;
      }
    }
    const started = Date.now();
    logSync('info', `push ${entry.kind}`, { id: entry.entity_id });
    try {
      await pushOne(client, ownerId, entry);
      await markDone(entry.id);
      ok += 1;
      logSync('info', `push ${entry.kind} done in ${Date.now() - started}ms`);
    } catch (err) {
      const msg = (err as Error).message;
      await markFailed(entry.id, msg);
      failed += 1;
      logSync('error', `push ${entry.kind} FAILED after ${Date.now() - started}ms`, {
        id: entry.entity_id,
        error: msg,
      });
      reportError(err, { operation: 'push', tags: { kind: entry.kind } });
      // Stop on first failure so we don't batter the server with a broken
      // entry; the caller's retry schedule will pick it up.
      break;
    }
    i += 1;
  }
  logSync('info', `push complete: ${ok} ok, ${failed} failed`);
  return { ok, failed };
}

function summarizeKinds(entries: readonly OutboxEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return counts;
}

// Server max-rows cap is 1000; supabase-js encodes the upsert body in
// the request, so keep chunks well below the gateway's body limit.
const IMPORT_ITEM_PUSH_CHUNK = 100;

async function pushImportItemsBulk(
  client: CookbooksClient,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const db = await getLocalDb();
  type ItemInsert = Database['public']['Tables']['import_items']['Insert'];
  for (let offset = 0; offset < ids.length; offset += IMPORT_ITEM_PUSH_CHUNK) {
    const slice = ids.slice(offset, offset + IMPORT_ITEM_PUSH_CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = (await db.execO<Record<string, unknown>>(
      `select * from import_items where id in (${placeholders})`,
      slice as unknown as string[],
    )) as Record<string, unknown>[];
    if (rows.length === 0) continue;
    const payload: ItemInsert[] = rows.map((local) => ({
      id: local.id as string,
      batch_id: local.batch_id as string,
      owner_id: local.owner_id as string,
      page_index: local.page_index as number,
      storage_path: local.storage_path as string,
      thumb_path: (local.thumb_path as string | null) ?? null,
      source_pdf_path: (local.source_pdf_path as string | null) ?? null,
      source_pdf_page: (local.source_pdf_page as number | null) ?? null,
      assigned_collection_id: (local.assigned_collection_id as string | null) ?? null,
      assigned_page_number: (local.assigned_page_number as number | null) ?? null,
      assigned_recipe_id: (local.assigned_recipe_id as string | null) ?? null,
      is_toc: local.is_toc === 1 || local.is_toc === true,
      kind: (local.kind as string) ?? 'RECIPE',
      status: local.status as ItemInsert['status'],
    }));
    const { error } = await client
      .from('import_items')
      .upsert(payload, { onConflict: 'id' });
    if (error) throw error;
  }
}

async function pushOne(
  client: CookbooksClient,
  ownerId: string,
  entry: OutboxEntry,
): Promise<void> {
  switch (entry.kind) {
    case 'collection_save':
      return pushCollection(client, ownerId, entry.entity_id);
    case 'collection_delete': {
      const { error } = await client
        .from('recipe_collections')
        .delete()
        .eq('id', entry.entity_id);
      if (error) throw error;
      return;
    }
    case 'recipe_save': {
      if (!entry.collection_id) throw new Error('recipe_save entry missing collection_id');
      return pushRecipe(client, entry.collection_id, entry.entity_id);
    }
    case 'recipe_delete': {
      const { error } = await client.from('recipes').delete().eq('id', entry.entity_id);
      if (error) throw error;
      return;
    }
    case 'recipe_reorder': {
      return pushRecipeReorder(client, entry.entity_id);
    }
    case 'import_batch_insert':
      return pushImportBatchInsert(client, entry.entity_id);
    case 'import_batch_update':
      return pushImportBatch(client, entry.entity_id);
    case 'import_item_insert':
      return pushImportItemInsert(client, entry.entity_id);
    case 'import_item_update':
      return pushImportItem(client, entry.entity_id);
    case 'conversion_rule_save':
      return pushConversionRule(client, entry.entity_id);
    case 'conversion_rule_delete': {
      const { error } = await client.rpc('house_conversion_delete', { p_id: entry.entity_id });
      if (error) throw error;
      return;
    }
    case 'embedding_push':
      return pushRecipeEmbedding(client, entry.entity_id);
    case 'cooking_event_save':
      return pushCookingEvent(client, ownerId, entry.entity_id);
    case 'cooking_event_delete': {
      const { error } = await client.from('cooking_events').delete().eq('id', entry.entity_id);
      if (error) throw error;
      return;
    }
    case 'recipe_tag_save':
      return pushRecipeTag(client, ownerId, entry.entity_id);
    case 'recipe_tag_delete': {
      const { error } = await client.from('recipe_tags').delete().eq('id', entry.entity_id);
      if (error) throw error;
      return;
    }
    case 'collection_note_save':
      return pushCollectionNote(client, ownerId, entry.entity_id);
    case 'collection_note_delete': {
      const { error } = await client.from('collection_notes').delete().eq('id', entry.entity_id);
      if (error) throw error;
      return;
    }
  }
}

async function pushRecipeEmbedding(
  client: CookbooksClient,
  recipeId: string,
): Promise<void> {
  const local = await getLocalEmbedding(recipeId);
  if (!local) {
    // The save flow already deleted it (e.g. recipe purge), or the
    // embedder never finished. Treat as a no-op — better than failing
    // an outbox entry the user can't retry by hand.
    return;
  }
  // Vector goes over the wire as a plain number[]; the RPC casts to
  // vector(384). PostgREST happily serializes Float32Array as JSON
  // numbers via Array.from.
  const payload = Array.from(local.embedding);
  const { error } = await client.rpc('embed_upsert_client', {
    p_recipe_id: recipeId,
    p_text_hash: local.textHash,
    p_embedding: payload as unknown as number[],
    p_model: local.model,
  });
  if (error) throw error;
}

async function pushCookingEvent(
  client: CookbooksClient,
  ownerId: string,
  id: string,
): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<Record<string, unknown>>(
    `select * from cooking_events where id = ?`,
    [id],
  )) as Record<string, unknown>[];
  const local = rows[0];
  if (!local) return; // locally purged; a delete was queued separately
  if (local.deleted === 1 || local.deleted === true) {
    const { error } = await client.from('cooking_events').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  type EventInsert = Database['public']['Tables']['cooking_events']['Insert'];
  const adjustments = parseJsonField(local.adjustments) ?? [];
  const snapshot =
    local.recipe_snapshot === null || local.recipe_snapshot === undefined
      ? null
      : parseJsonField(local.recipe_snapshot);
  const photoPaths = parseJsonField(local.photo_paths) ?? [];
  const payload: EventInsert = {
    id: local.id as string,
    owner_id: ownerId,
    // null once the recipe is gone — the snapshot keeps the entry readable.
    recipe_id: (local.recipe_id as string | null) ?? null,
    status: local.status as string,
    event_date: local.event_date as string,
    occasion_category: (local.occasion_category as string | null) ?? null,
    meal_slot: (local.meal_slot as string | null) ?? null,
    occasion_note: (local.occasion_note as string | null) ?? null,
    notes: (local.notes as string | null) ?? null,
    adjustments: adjustments as EventInsert['adjustments'],
    recipe_snapshot: snapshot as EventInsert['recipe_snapshot'],
    photo_paths: photoPaths as EventInsert['photo_paths'],
  };
  const { error } = await client.from('cooking_events').upsert(payload, { onConflict: 'id' });
  if (error) throw error;
}

async function pushRecipeTag(
  client: CookbooksClient,
  ownerId: string,
  id: string,
): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<Record<string, unknown>>(
    `select * from recipe_tags where id = ?`,
    [id],
  )) as Record<string, unknown>[];
  const local = rows[0];
  if (!local) return;
  type TagInsert = Database['public']['Tables']['recipe_tags']['Insert'];
  const payload: TagInsert = {
    id: local.id as string,
    owner_id: ownerId,
    recipe_id: local.recipe_id as string,
    label: local.label as string,
  };
  // Conflict on the natural key, NOT id: a re-add of the same (owner,
  // recipe, label) from a second device must not violate the server's
  // unique constraint or create a duplicate row.
  const { error } = await client
    .from('recipe_tags')
    .upsert(payload, { onConflict: 'owner_id,recipe_id,label' });
  if (error) throw error;
}

async function pushCollectionNote(
  client: CookbooksClient,
  ownerId: string,
  id: string,
): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<Record<string, unknown>>(
    `select * from collection_notes where id = ?`,
    [id],
  )) as Record<string, unknown>[];
  const local = rows[0];
  if (!local) return;
  type NoteInsert = Database['public']['Tables']['collection_notes']['Insert'];
  // Only user-editable fields flow through the outbox; import_item_id,
  // source_image_text and page_numbers are worker-owned and preserved by the
  // server's conflict-update. household_id is re-stamped by the owner trigger.
  const payload: NoteInsert = {
    id: local.id as string,
    owner_id: ownerId,
    collection_id: (local.collection_id as string | null) ?? null,
    title: (local.title as string) ?? '',
    body: (local.body as string) ?? '',
    sort_order: (local.sort_order as number) ?? 0,
  };
  const { error } = await client.from('collection_notes').upsert(payload, { onConflict: 'id' });
  if (error) throw error;
}

// ---------- push: bulk OCR imports ----------
//
// Most columns on these tables are server-owned (the Edge Function
// worker is the canonical writer). Only the user-editable annotations
// flow through the outbox. Anything else is scrubbed before upsert so a
// careless local-side write can't clobber server bookkeeping. RLS would
// also reject worker-only columns from an `authenticated` JWT, but the
// scrub keeps the request shape predictable.

async function pushImportBatchInsert(
  client: CookbooksClient,
  id: string,
): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<Record<string, unknown>>(
    `select * from import_batches where id = ?`,
    [id],
  )) as Record<string, unknown>[];
  const local = rows[0];
  if (!local) return;
  type BatchInsert = Database['public']['Tables']['import_batches']['Insert'];
  const payload = {
    id: local.id as string,
    owner_id: local.owner_id as string,
    name: local.name as string,
    batch_kind: (local.batch_kind as string | undefined) ?? 'STANDARD',
    source_kind: local.source_kind as 'IMAGES' | 'PDF',
    target_collection_id: (local.target_collection_id as string | null) ?? null,
    default_model: local.default_model as string,
    default_provider: local.default_provider as 'gemini' | 'openai-compatible',
    default_prompt: (local.default_prompt as string | null) ?? null,
    fallback_model: (local.fallback_model as string | null) ?? null,
    fallback_provider:
      (local.fallback_provider as 'gemini' | 'openai-compatible' | null) ?? null,
    key_owner_id: (local.key_owner_id as string | null) ?? null,
    status: local.status as 'OPEN' | 'ARCHIVED',
    is_planner: local.is_planner === 1 || local.is_planner === true,
  } as BatchInsert;
  const { error } = await client
    .from('import_batches')
    .upsert(payload, { onConflict: 'id' });
  if (error) throw error;
}

async function pushImportItemInsert(
  client: CookbooksClient,
  id: string,
): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<Record<string, unknown>>(
    `select * from import_items where id = ?`,
    [id],
  )) as Record<string, unknown>[];
  const local = rows[0];
  if (!local) return;
  type ItemInsert = Database['public']['Tables']['import_items']['Insert'];
  // Status is included so that AWAITING_GROUPING uploads don't get
  // silently re-defaulted to PENDING on the server side and immediately
  // picked up by the worker before the user finishes grouping.
  const payload: ItemInsert = {
    id: local.id as string,
    batch_id: local.batch_id as string,
    owner_id: local.owner_id as string,
    page_index: local.page_index as number,
    storage_path: local.storage_path as string,
    thumb_path: (local.thumb_path as string | null) ?? null,
    source_pdf_path: (local.source_pdf_path as string | null) ?? null,
    source_pdf_page: (local.source_pdf_page as number | null) ?? null,
    assigned_collection_id: (local.assigned_collection_id as string | null) ?? null,
    assigned_page_number: (local.assigned_page_number as number | null) ?? null,
    assigned_recipe_id: (local.assigned_recipe_id as string | null) ?? null,
    is_toc: local.is_toc === 1 || local.is_toc === true,
    kind: (local.kind as string) ?? 'RECIPE',
    status: local.status as ItemInsert['status'],
  };
  const { error } = await client
    .from('import_items')
    .upsert(payload, { onConflict: 'id' });
  if (error) throw error;
}

/**
 * Push a locally-minted import batch and all of its items to Supabase.
 * Upload flows write metadata locally first and enqueue outbox pushes;
 * server-side import RPCs (e.g. `import_finalize_grouping`) fail with
 * "Batch not found or not owned by caller" if called before that push
 * lands. Call this immediately before any such RPC.
 */
export async function pushImportBatchGraph(
  client: CookbooksClient,
  batchId: string,
): Promise<void> {
  await pushImportBatchInsert(client, batchId);
  const db = await getLocalDb();
  const rows = (await db.execO<{ id: string }>(
    `select id from import_items where batch_id = ? and deleted = 0 order by page_index`,
    [batchId],
  )) as { id: string }[];
  await pushImportItemsBulk(
    client,
    rows.map((r) => r.id),
  );
  // The direct push above supersedes any still-pending outbox entries
  // for this batch graph — drop them so a later full sync doesn't
  // retry redundant upserts.
  await db.exec(
    `delete from outbox
      where (kind in ('import_batch_insert', 'import_batch_update') and entity_id = ?)
         or (kind = 'import_item_insert' and entity_id in (
           select id from import_items where batch_id = ?
         ))`,
    [batchId, batchId],
  );
}

async function pushConversionRule(client: CookbooksClient, id: string): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<Record<string, unknown>>(
    `select * from conversion_rules where id = ?`,
    [id],
  )) as Record<string, unknown>[];
  const local = rows[0];
  if (!local) return;
  // The RPC is a true upsert keyed by id: inserts if the row doesn't
  // exist server-side (first push of a locally-minted rule), updates
  // if it does (subsequent edits).
  const { error } = await client.rpc('house_conversion_upsert', {
    p_id: local.id as string,
    p_from_unit: local.from_unit as string,
    p_to_unit: local.to_unit as string,
    p_factor: local.factor as number,
    p_ingredient_name: (local.ingredient_name as string | null) ?? undefined,
    p_notes: (local.notes as string | null) ?? undefined,
  });
  if (error) throw error;
}

async function pushImportBatch(client: CookbooksClient, id: string): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<Record<string, unknown>>(
    `select * from import_batches where id = ?`,
    [id],
  )) as Record<string, unknown>[];
  const local = rows[0];
  if (!local) return;
  const payload = {
    name: local.name as string,
    target_collection_id: (local.target_collection_id as string | null) ?? null,
    recitation_policy: local.recitation_policy as string,
    status: local.status as string,
    default_model: local.default_model as string,
    default_provider: local.default_provider as string,
    fallback_model: (local.fallback_model as string | null) ?? null,
    fallback_provider: (local.fallback_provider as string | null) ?? null,
  };
  const { error } = await client.from('import_batches').update(payload).eq('id', id);
  if (error) throw error;
}

async function pushImportItem(client: CookbooksClient, id: string): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<Record<string, unknown>>(
    `select * from import_items where id = ?`,
    [id],
  )) as Record<string, unknown>[];
  const local = rows[0];
  if (!local) return;
  const status = local.status as string;
  // Clients can only park items in REVIEWED or DISCARDED — every other
  // status transition is the worker's call. Drop status from the
  // payload otherwise so a buggy local write can't kick a CLAIMED row
  // back to PENDING.
  const allowStatus = status === 'REVIEWED' || status === 'DISCARDED';
  const createdIdsRaw = local.created_recipe_ids;
  let createdIds: string[] = [];
  if (typeof createdIdsRaw === 'string' && createdIdsRaw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(createdIdsRaw);
      if (Array.isArray(parsed)) {
        createdIds = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      createdIds = [];
    }
  }
  // `needs_fallback` is server-owned (set by import_fail / cleared by
  // import_complete / flipped by import_set_recitation_policy). Never
  // include it in the outbox push payload.
  //
  // `parsed_drafts_json` IS pushed — once OCR_DONE, the user owns the
  // draft list (promoting / discarding individual drafts). Without this
  // line the next pull would restore the worker's original draft set
  // and silently undo the user's edits.
  const draftsRaw = local.parsed_drafts_json;
  let parsedDrafts: unknown = null;
  if (typeof draftsRaw === 'string' && draftsRaw.length > 0) {
    try {
      parsedDrafts = JSON.parse(draftsRaw);
    } catch {
      parsedDrafts = null;
    }
  }
  type ItemUpdate = Database['public']['Tables']['import_items']['Update'];
  const payload: ItemUpdate = {
    assigned_collection_id: (local.assigned_collection_id as string | null) ?? null,
    assigned_page_number: (local.assigned_page_number as number | null) ?? null,
    assigned_recipe_id: (local.assigned_recipe_id as string | null) ?? null,
    is_toc: local.is_toc === 1 || local.is_toc === true,
    kind: (local.kind as string) ?? 'RECIPE',
    created_recipe_ids: createdIds,
    parsed_drafts_json: parsedDrafts as ItemUpdate['parsed_drafts_json'],
  };
  if (allowStatus) payload.status = status;
  const { error } = await client.from('import_items').update(payload).eq('id', id);
  if (error) throw error;
}

/** Push-only helper for drag-and-drop reordering — writes just the
 *  `sort_order` column so we don't churn child rows on the server. */
async function pushRecipeReorder(client: CookbooksClient, id: string): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<{ sort_order: number }>(
    `select sort_order from recipes where id = ?`,
    [id],
  )) as { sort_order: number }[];
  const local = rows[0];
  if (!local) return;
  const { error } = await client
    .from('recipes')
    .update({ sort_order: local.sort_order })
    .eq('id', id);
  if (error) throw error;
}

async function pushCollection(
  client: CookbooksClient,
  ownerId: string,
  id: string,
): Promise<void> {
  const db = await getLocalDb();
  const rows = (await db.execO<CollectionRow & { deleted: number }>(
    `select * from recipe_collections where id = ?`,
    [id],
  )) as (CollectionRow & { deleted: number })[];
  const local = rows[0];
  if (!local) {
    // Locally purged — nothing to push. A delete would have been queued
    // separately as 'collection_delete'.
    return;
  }
  const { deleted, ...row } = local;
  if (deleted) {
    const { error } = await client.from('recipe_collections').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  // Server owns `created_at` / `updated_at` (locally they're ms integers
  // and Postgres would reject them as timestamptz). Also strip the
  // moderation columns — those are admin-RPC-only. Sending them from a
  // regular owner-save shouldn't be possible via RLS, but we defensively
  // scrub the payload to avoid a surprise.
  const {
    created_at: _c,
    updated_at: _u,
    moderation_state: _ms,
    moderation_reason: _mr,
    ...serverRow
  } = row as CollectionRow & {
    created_at?: unknown;
    updated_at?: unknown;
    moderation_state?: unknown;
    moderation_reason?: unknown;
  };
  const { error } = await client
    .from('recipe_collections')
    .upsert(
      { ...serverRow, owner_id: ownerId, is_public: !!serverRow.is_public },
      { onConflict: 'id' },
    );
  if (error) throw error;
}

/** The jsonb shape one recipe contributes to the save_recipes_graph RPC. */
interface RecipeGraphItem {
  recipe: Record<string, unknown>;
  ingredients: IngredientRow[];
  instructions: Array<Record<string, unknown>>;
  refs: InstructionRefRow[];
}

type RecipeLoadResult =
  | { kind: 'gone' }
  | { kind: 'delete' }
  | { kind: 'save'; item: RecipeGraphItem };

/**
 * Read a recipe's full graph from local and normalize it into the shape
 * the save_recipes_graph RPC consumes. Local SQLite stores array columns
 * (equipment, page_numbers, sub_instructions) as JSON *text* and booleans
 * as 0/1; we parse/normalize here so the server's jsonb_populate_record
 * sees native arrays and real booleans.
 */
async function loadRecipeForPush(
  db: Awaited<ReturnType<typeof getLocalDb>>,
  collectionId: string,
  id: string,
): Promise<RecipeLoadResult> {
  const recipeRows = (await db.execO<RecipeRow & { deleted: number }>(
    `select * from recipes where id = ?`,
    [id],
  )) as (RecipeRow & { deleted: number })[];
  const recipe = recipeRows[0];
  if (!recipe) return { kind: 'gone' };
  if (recipe.deleted) return { kind: 'delete' };

  const [ingRows, stepRows, refRows] = await Promise.all([
    db.execO<IngredientRow>(
      `select * from ingredients where recipe_id = ? order by sort_order asc`,
      [id],
    ) as Promise<IngredientRow[]>,
    db.execO<InstructionRow>(
      `select * from instructions where recipe_id = ? order by step_number asc`,
      [id],
    ) as Promise<InstructionRow[]>,
    db.execO<InstructionRefRow>(
      `select r.*
       from instruction_ingredient_refs r
       join instructions i on i.id = r.instruction_id
       where i.recipe_id = ?`,
      [id],
    ) as Promise<InstructionRefRow[]>,
  ]);

  // Drop client-only / trigger-owned columns; the RPC injects created_at /
  // updated_at, the server has no `deleted` column, and has_content is owned by
  // the server trigger on ingredients/instructions (20260629000000).
  const {
    deleted: _d,
    created_at: _rc,
    updated_at: _ru,
    has_content: _hc,
    ...recipeRow
  } = recipe as RecipeRow & {
    deleted: number;
    created_at?: unknown;
    updated_at?: unknown;
    has_content?: unknown;
  };
  const starredRaw = (recipeRow as { starred?: unknown }).starred;
  const recipePayload: Record<string, unknown> = {
    ...recipeRow,
    collection_id: collectionId,
    equipment: parseJsonField((recipeRow as { equipment?: unknown }).equipment),
    page_numbers: parseJsonField((recipeRow as { page_numbers?: unknown }).page_numbers),
    starred: starredRaw === true || starredRaw === 1,
  };
  const instructions = stepRows.map((s) => {
    const sx = s as InstructionRow & { sub_instructions?: unknown };
    return { ...s, sub_instructions: parseJsonField(sx.sub_instructions) };
  });
  return {
    kind: 'save',
    item: { recipe: recipePayload, ingredients: ingRows, instructions, refs: refRows },
  };
}

/**
 * Push a batch of recipe graphs in one transactional RPC round-trip
 * (replaces the old 6-round-trips-per-recipe upsert/delete/insert dance —
 * see migration 20260614000000). The RPC is SECURITY INVOKER, so RLS
 * still gates every write exactly as the direct PostgREST calls did.
 */
async function saveRecipeGraphs(
  client: CookbooksClient,
  items: readonly RecipeGraphItem[],
): Promise<void> {
  if (items.length === 0) return;
  const { error } = await client.rpc('save_recipes_graph', {
    p_recipes: items as unknown as Json,
  });
  if (error) throw error;
}

// Recipe graphs are larger than import-item rows; keep transactions short
// on the constrained prod box and the request body under the gateway cap.
const RECIPE_SAVE_PUSH_CHUNK = 25;

/**
 * Drain a contiguous run of recipe_save outbox entries. Non-deleted
 * recipes are buffered and flushed in chunks through save_recipes_graph;
 * deletes execute in order (a buffer flush precedes each, so a delete
 * never races a buffered save of the same id). On any error this throws —
 * the caller attributes the failure to the run's first entry and leaves
 * the run queued; the next cycle re-pushes idempotently.
 */
async function pushRecipeSavesRun(
  client: CookbooksClient,
  run: readonly OutboxEntry[],
): Promise<void> {
  const db = await getLocalDb();
  let buffer: RecipeGraphItem[] = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    await saveRecipeGraphs(client, buffer);
    buffer = [];
  };
  for (const entry of run) {
    if (!entry.collection_id) throw new Error('recipe_save entry missing collection_id');
    const loaded = await loadRecipeForPush(db, entry.collection_id, entry.entity_id);
    if (loaded.kind === 'gone') continue;
    if (loaded.kind === 'delete') {
      await flush();
      const { error } = await client.from('recipes').delete().eq('id', entry.entity_id);
      if (error) throw error;
      continue;
    }
    buffer.push(loaded.item);
    if (buffer.length >= RECIPE_SAVE_PUSH_CHUNK) await flush();
  }
  await flush();
}

async function pushRecipe(
  client: CookbooksClient,
  collectionId: string,
  id: string,
): Promise<void> {
  const db = await getLocalDb();
  const loaded = await loadRecipeForPush(db, collectionId, id);
  if (loaded.kind === 'gone') return;
  if (loaded.kind === 'delete') {
    const { error } = await client.from('recipes').delete().eq('id', id);
    if (error) throw error;
    return;
  }
  await saveRecipeGraphs(client, [loaded.item]);
}

// Local SQLite stores array-valued columns (equipment, page_numbers,
// sub_instructions) as JSON text. Postgres expects native arrays in
// jsonb columns. Normalize on push.
function parseJsonField(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    if (val.length === 0) return null;
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return val;
}
