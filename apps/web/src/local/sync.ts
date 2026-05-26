import type {
  CollectionRow,
  IngredientRow,
  InstructionRefRow,
  InstructionRow,
  RecipeRow,
} from '@cookyourbooks/db';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@cookyourbooks/db';
import { getLocalDb } from './db.js';
import {
  purgeCollection,
  purgeRecipe,
  upsertCollectionRow,
  upsertCollectionsBatch,
  upsertRecipeRow,
  upsertRecipesBatch,
  withSuppressedCrrTriggers,
  filterFresherIncoming,
  bulkInsertOnConflictId,
  bulkInsertIgnoreId,
} from './repositories.js';
import {
  listPending,
  markDone,
  markFailed,
  type OutboxEntry,
} from './outbox.js';
import { logSync } from './syncLog.js';

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

function toMs(ts: string | number | null | undefined): number {
  if (typeof ts === 'number') return ts;
  if (!ts) return 0;
  const p = Date.parse(ts);
  return Number.isFinite(p) ? p : 0;
}

// PostgREST silently caps responses at the project's max-rows setting
// (1000 by default on Supabase). For libraries with > PAGE_SIZE rows,
// every `pullAll` table query has to page with `.range()` or new rows
// past the cap never reach the local cache. PAGE_SIZE matches the
// server cap so a "fewer than PAGE_SIZE returned" check is a reliable
// end-of-stream signal.
const PAGE_SIZE = 1000;

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
 */
async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await build(from, to);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
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
  fallback_model: string | null;
  fallback_provider: 'gemini' | 'openai-compatible' | null;
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

// Bumped whenever a sync bug invalidates existing watermarks. On the
// first pull after the user upgrades, every per-topic watermark is
// reset to 0 so missed rows get a chance to flow in. Increment when
// fixing a pull bug that could have stranded server rows.
const SYNC_RESET_VERSION = 4;

async function maybeResetWatermarks(ownerId: string): Promise<void> {
  const versionTopic = `sync_reset_version:${ownerId}`;
  const current = await getWatermark(versionTopic);
  if (current >= SYNC_RESET_VERSION) return;
  const db = await getLocalDb();
  await db.exec(
    `delete from sync_state where topic in (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `collections:${ownerId}`,
      `recipes:${ownerId}`,
      `import_batches:${ownerId}`,
      `import_items:${ownerId}`,
      `import_item_attempts:${ownerId}`,
      `import_toc_entries:${ownerId}`,
      `conversion_rules:${ownerId}`,
      `rewrite_jobs:${ownerId}`,
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
  onPhaseComplete?: (phase: 'collections' | 'recipes' | 'imports' | 'conversion_rules' | 'rewrite_jobs') => void;
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
  const recipesSince = new Date(await getWatermark(recipeTopic)).toISOString();
  const recipesPhase = Date.now();

  // Recipes (+ their ingredients / instructions / refs) are scoped via
  // PostgREST embedded-resource inner joins. The old approach assembled
  // a `.in('collection_id', […])` over every collection the user knew
  // about and then a `.in('recipe_id', […])` over every recipe that
  // had changed — for libraries with thousands of items that ran past
  // PostgREST's URL/parameter ceiling. Filtering through the join
  // keeps the URL tiny no matter how many rows the user owns.
  //
  // Each `.range()` page is bounded by the project's max-rows cap
  // (1000), so we loop until exhausted — without this, libraries past
  // 1000 recipes never sync the rows beyond the cap and newly-saved
  // recipes silently fail to appear on other devices.
  const recipeRowsRaw = await fetchAllPages<RecipeRow & { recipe_collections?: unknown }>(
    (from, to) =>
      client
        .from('recipes')
        .select('*, recipe_collections!inner(owner_id)')
        .eq('recipe_collections.owner_id', ownerId)
        .gte('updated_at', recipesSince)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  );
  const recipesFetched: RecipeRow[] = recipeRowsRaw.map((row) => {
    const { recipe_collections: _rc, ...rest } = row;
    return rest as RecipeRow;
  });

  let maxRecipeTs = await getWatermark(recipeTopic);
  let ingTotal = 0;
  let stepTotal = 0;

  if (recipesFetched.length > 0) {
    // Children: filter by the parent recipe's `updated_at` so we only
    // re-pull children for recipes that actually changed this round.
    // Save flow rewrites all children on every recipe save, so the
    // parent's updated_at moving is a sufficient signal. Each child
    // table is paginated independently — the join filter keeps the URL
    // small no matter how many parents matched.
    const [ingsRaw, stepsRaw, refsRaw] = await Promise.all([
      fetchAllPages<IngredientRow & { recipes?: unknown }>((from, to) =>
        client
          .from('ingredients')
          .select('*, recipes!inner(updated_at, recipe_collections!inner(owner_id))')
          .eq('recipes.recipe_collections.owner_id', ownerId)
          .gte('recipes.updated_at', recipesSince)
          .order('recipe_id', { ascending: true })
          .order('sort_order', { ascending: true })
          .range(from, to),
      ),
      fetchAllPages<InstructionRow & { recipes?: unknown }>((from, to) =>
        client
          .from('instructions')
          .select('*, recipes!inner(updated_at, recipe_collections!inner(owner_id))')
          .eq('recipes.recipe_collections.owner_id', ownerId)
          .gte('recipes.updated_at', recipesSince)
          .order('recipe_id', { ascending: true })
          .order('step_number', { ascending: true })
          .range(from, to),
      ),
      fetchAllPages<InstructionRefRow & { instructions?: { recipe_id?: string } }>(
        (from, to) =>
          client
            .from('instruction_ingredient_refs')
            .select(
              '*, instructions!inner(recipe_id, recipes!inner(updated_at, recipe_collections!inner(owner_id)))',
            )
            .eq('instructions.recipes.recipe_collections.owner_id', ownerId)
            .gte('instructions.recipes.updated_at', recipesSince)
            .order('instruction_id', { ascending: true })
            .range(from, to),
      ),
    ]);

    const ings = stripEmbedded(ingsRaw, 'recipes');
    const steps = stripEmbedded(stepsRaw, 'recipes');
    const ingByRecipe = groupBy(ings, (i) => i.recipe_id);
    const stepsByRecipe = groupBy(steps, (s) => s.recipe_id);

    const refsByRecipe = new Map<string, InstructionRefRow[]>();
    for (const row of refsRaw) {
      const recipeId = row.instructions?.recipe_id ?? '';
      const { instructions: _i, ...refOnly } = row;
      if (!recipeId) continue;
      const arr = refsByRecipe.get(recipeId) ?? [];
      arr.push(refOnly as InstructionRefRow);
      refsByRecipe.set(recipeId, arr);
    }

    // Bulk-upsert the entire recipe batch in one SQLite transaction.
    // Per-recipe upsertRecipeRow each pays a lock + tx start/commit;
    // on iPad WASM SQLite that's ~50ms per recipe, so a 100-recipe
    // pull can take ~30s with the UI deceptively "Synced" and all
    // other readers stuck behind the recipe loop's lock churn.
    const batch = recipesFetched.map((r) => ({
      recipe: r,
      ingredients: ingByRecipe.get(r.id) ?? [],
      instructions: stepsByRecipe.get(r.id) ?? [],
      refs: refsByRecipe.get(r.id) ?? [],
    }));
    await upsertRecipesBatch(batch, signal);
    for (const { recipe, ingredients, instructions } of batch) {
      ingTotal += ingredients.length;
      stepTotal += instructions.length;
      maxRecipeTs = Math.max(maxRecipeTs, toMs(recipe.updated_at));
    }
    if (maxRecipeTs > 0) await bumpWatermark(recipeTopic, maxRecipeTs);
  }
  logSync(
    'info',
    `pull recipes: ${recipesFetched.length} rows in ${Date.now() - recipesPhase}ms`,
  );
  callbacks?.onPhaseComplete?.('recipes');

  // Tail topics (imports, conversion_rules, rewrite_jobs) have no FK
  // or RLS dependency on each other. Run them in parallel so network
  // fetches overlap; their local-write phases still serialize on the
  // SQLite mutex, but each phase is now O(few statements) thanks to
  // bulk INSERTs + trigger suppression, so the contention is small.
  checkAbort('imports');
  const importPhase = Date.now();
  const convPhase = Date.now();
  const rewritePhase = Date.now();
  const [importCounts, conversionRulesPulled, rewriteJobsPulled] = await Promise.all([
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
  ]);
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
  };
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

const IMPORT_BATCH_COLS = [
  'id',
  'owner_id',
  'name',
  'batch_kind',
  'source_kind',
  'target_collection_id',
  'default_model',
  'default_provider',
  'fallback_model',
  'fallback_provider',
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
    row.fallback_model,
    row.fallback_provider,
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
    const fresh = await filterFresherIncoming(
      'conversion_rules',
      rows,
      (r) => r.id,
      (r) => toMs(r.updated_at),
    );
    if (fresh.length > 0) {
      await withSuppressedCrrTriggers(['conversion_rules'], () =>
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
      await withSuppressedCrrTriggers(['rewrite_jobs'], () =>
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
        is_toc, status, claim_expires_at, attempts, last_error,
        parsed_drafts_json, model_used, prompt_tokens, completion_tokens,
        cost_usd_micros, created_recipe_ids, selected_variant_id,
        needs_fallback, extra_storage_paths, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
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

function stripEmbedded<T extends Record<string, unknown>>(
  rows: T[],
  field: string,
): T[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    delete copy[field];
    return copy as T;
  });
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
}

export function subscribeRealtime(
  client: CookbooksClient,
  ownerId: string,
  callbacks: RealtimeCallbacks,
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
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipes' },
      async (payload) => {
        await handleRecipeEvent(client, payload);
        onLocalUpdate();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ingredients' },
      async () => {
        // Ingredients don't carry owner info; piggy-back on the recipe's
        // next refresh instead of doing a broad refetch per event.
        onNeedsPull();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'instructions' },
      async () => {
        onNeedsPull();
      },
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
    .subscribe();

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

async function handleRecipeEvent(
  client: CookbooksClient,
  payload: RealtimePayload,
): Promise<void> {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id;
    if (id) await purgeRecipe(id);
    return;
  }
  // Re-fetch children on insert/update since the event only carries the
  // parent row. Cheaper than subscribing with an IN-filter per collection.
  const recipeRow = payload.new as RecipeRow;
  const [ingRes, stepRes] = await Promise.all([
    client.from('ingredients').select('*').eq('recipe_id', recipeRow.id),
    client.from('instructions').select('*').eq('recipe_id', recipeRow.id),
  ]);
  if (ingRes.error || stepRes.error) return;
  await upsertRecipeRow(
    recipeRow,
    (ingRes.data ?? []) as IngredientRow[],
    (stepRes.data ?? []) as InstructionRow[],
  );
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
  await upsertConversionRuleRow(payload.new as unknown as ConversionRuleRow);
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
  }
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
    fallback_model: (local.fallback_model as string | null) ?? null,
    fallback_provider:
      (local.fallback_provider as 'gemini' | 'openai-compatible' | null) ?? null,
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
    p_ingredient_name: (local.ingredient_name as string | null) ?? null,
    p_notes: (local.notes as string | null) ?? null,
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

async function pushRecipe(
  client: CookbooksClient,
  collectionId: string,
  id: string,
): Promise<void> {
  const db = await getLocalDb();
  const recipeRows = (await db.execO<RecipeRow & { deleted: number }>(
    `select * from recipes where id = ?`,
    [id],
  )) as (RecipeRow & { deleted: number })[];
  const recipe = recipeRows[0];
  if (!recipe) return;
  if (recipe.deleted) {
    const { error } = await client.from('recipes').delete().eq('id', id);
    if (error) throw error;
    return;
  }
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

  const { deleted, created_at: _rc, updated_at: _ru, ...recipeRow } = recipe as RecipeRow & {
    deleted: number;
    created_at?: unknown;
    updated_at?: unknown;
  };
  // Local SQLite stores array-valued columns as JSON *text*; Postgres
  // wants jsonb input. supabase-js would happily ship the text string
  // through — which gets stored as a JSON string, not an array — so
  // parse back to native arrays before upsert. Same on the
  // instruction side below.
  // SQLite stores boolean as 0/1; PostgREST rejects integers in a
  // boolean column. Normalize before the upsert.
  const starredRaw = (recipeRow as { starred?: unknown }).starred;
  const recipePayload = {
    ...recipeRow,
    collection_id: collectionId,
    equipment: parseJsonField((recipeRow as { equipment?: unknown }).equipment),
    page_numbers: parseJsonField((recipeRow as { page_numbers?: unknown }).page_numbers),
    starred: starredRaw === true || starredRaw === 1,
  } as RecipeRow;
  const { error: rErr } = await client
    .from('recipes')
    .upsert(recipePayload, { onConflict: 'id' });
  if (rErr) throw rErr;

  // Replace children wholesale. Matches the server-side save behavior.
  const delIng = await client.from('ingredients').delete().eq('recipe_id', id);
  if (delIng.error) throw delIng.error;
  const delStep = await client.from('instructions').delete().eq('recipe_id', id);
  if (delStep.error) throw delStep.error;

  if (ingRows.length > 0) {
    const { error } = await client.from('ingredients').insert(ingRows);
    if (error) throw error;
  }
  if (stepRows.length > 0) {
    const payload = stepRows.map((s) => {
      const sx = s as InstructionRow & { sub_instructions?: unknown };
      return {
        ...s,
        sub_instructions: parseJsonField(sx.sub_instructions),
      } as InstructionRow;
    });
    const { error } = await client.from('instructions').insert(payload);
    if (error) throw error;
  }
  // Refs cascade via FK when the parent instructions were deleted above,
  // so no explicit delete is needed — just insert the current set.
  if (refRows.length > 0) {
    const { error } = await client.from('instruction_ingredient_refs').insert(refRows);
    if (error) throw error;
  }
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
