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
  upsertRecipeRow,
} from './repositories.js';
import {
  listPending,
  markDone,
  markFailed,
  type OutboxEntry,
} from './outbox.js';

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
  source_kind: 'IMAGES' | 'PDF';
  target_collection_id: string | null;
  default_model: string;
  default_provider: 'gemini' | 'openai-compatible';
  fallback_model: string | null;
  fallback_provider: 'gemini' | 'openai-compatible' | null;
  recitation_policy: 'ASK' | 'FALLBACK' | 'FAIL';
  status: 'OPEN' | 'ARCHIVED';
  total_items: number;
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
  is_toc: boolean;
  status:
    | 'PENDING'
    | 'CLAIMED'
    | 'OCR_DONE'
    | 'NEEDS_FALLBACK'
    | 'OCR_FAILED'
    | 'REVIEWED'
    | 'DISCARDED';
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

export async function pullAll(
  client: CookbooksClient,
  ownerId: string,
): Promise<PullResult> {
  const collectionTopic = `collections:${ownerId}`;
  const collectionsSince = new Date(await getWatermark(collectionTopic)).toISOString();

  const { data: collections, error: colErr } = await client
    .from('recipe_collections')
    .select('*')
    .eq('owner_id', ownerId)
    .gte('updated_at', collectionsSince)
    .order('updated_at', { ascending: true });
  if (colErr) throw colErr;

  let maxCollectionTs = await getWatermark(collectionTopic);
  for (const row of collections ?? []) {
    await upsertCollectionRow(row as CollectionRow);
    maxCollectionTs = Math.max(maxCollectionTs, toMs((row as CollectionRow).updated_at));
  }
  if (maxCollectionTs > 0) await bumpWatermark(collectionTopic, maxCollectionTs);

  const recipeTopic = `recipes:${ownerId}`;
  const recipesSince = new Date(await getWatermark(recipeTopic)).toISOString();

  // Recipes (+ their ingredients / instructions / refs) are scoped via
  // PostgREST embedded-resource inner joins. The old approach assembled
  // a `.in('collection_id', […])` over every collection the user knew
  // about and then a `.in('recipe_id', […])` over every recipe that
  // had changed — for libraries with thousands of items that ran past
  // PostgREST's URL/parameter ceiling. Filtering through the join
  // keeps the URL tiny no matter how many rows the user owns.
  const { data: recipeRowsRaw, error: recErr } = await client
    .from('recipes')
    .select('*, recipe_collections!inner(owner_id)')
    .eq('recipe_collections.owner_id', ownerId)
    .gte('updated_at', recipesSince)
    .order('updated_at', { ascending: true });
  if (recErr) throw recErr;
  const recipesFetched: RecipeRow[] = (recipeRowsRaw ?? []).map((row) => {
    const { recipe_collections: _rc, ...rest } = row as RecipeRow & {
      recipe_collections?: unknown;
    };
    return rest as RecipeRow;
  });

  let maxRecipeTs = await getWatermark(recipeTopic);
  let ingTotal = 0;
  let stepTotal = 0;

  if (recipesFetched.length > 0) {
    // Children: filter by the parent recipe's `updated_at` so we only
    // re-pull children for recipes that actually changed this round.
    // Save flow rewrites all children on every recipe save, so the
    // parent's updated_at moving is a sufficient signal.
    const [ingRes, stepRes, refRes] = await Promise.all([
      client
        .from('ingredients')
        .select('*, recipes!inner(updated_at, recipe_collections!inner(owner_id))')
        .eq('recipes.recipe_collections.owner_id', ownerId)
        .gte('recipes.updated_at', recipesSince),
      client
        .from('instructions')
        .select('*, recipes!inner(updated_at, recipe_collections!inner(owner_id))')
        .eq('recipes.recipe_collections.owner_id', ownerId)
        .gte('recipes.updated_at', recipesSince),
      client
        .from('instruction_ingredient_refs')
        .select(
          '*, instructions!inner(recipe_id, recipes!inner(updated_at, recipe_collections!inner(owner_id)))',
        )
        .eq('instructions.recipes.recipe_collections.owner_id', ownerId)
        .gte('instructions.recipes.updated_at', recipesSince),
    ]);
    if (ingRes.error) throw ingRes.error;
    if (stepRes.error) throw stepRes.error;
    if (refRes.error) throw refRes.error;

    const ings = stripEmbedded(
      (ingRes.data ?? []) as Array<IngredientRow & { recipes?: unknown }>,
      'recipes',
    );
    const steps = stripEmbedded(
      (stepRes.data ?? []) as Array<InstructionRow & { recipes?: unknown }>,
      'recipes',
    );
    const ingByRecipe = groupBy(ings, (i) => i.recipe_id);
    const stepsByRecipe = groupBy(steps, (s) => s.recipe_id);

    const refRows = (refRes.data ?? []) as Array<
      InstructionRefRow & { instructions?: { recipe_id?: string } }
    >;
    const refsByRecipe = new Map<string, InstructionRefRow[]>();
    for (const row of refRows) {
      const recipeId = row.instructions?.recipe_id ?? '';
      const { instructions: _i, ...refOnly } = row as InstructionRefRow & {
        instructions?: unknown;
      };
      if (!recipeId) continue;
      const arr = refsByRecipe.get(recipeId) ?? [];
      arr.push(refOnly as InstructionRefRow);
      refsByRecipe.set(recipeId, arr);
    }

    for (const r of recipesFetched) {
      await upsertRecipeRow(
        r,
        ingByRecipe.get(r.id) ?? [],
        stepsByRecipe.get(r.id) ?? [],
        refsByRecipe.get(r.id) ?? [],
      );
      ingTotal += ingByRecipe.get(r.id)?.length ?? 0;
      stepTotal += stepsByRecipe.get(r.id)?.length ?? 0;
      maxRecipeTs = Math.max(maxRecipeTs, toMs(r.updated_at));
    }
    if (maxRecipeTs > 0) await bumpWatermark(recipeTopic, maxRecipeTs);
  }

  const importCounts = await pullImports(client, ownerId);

  return {
    collections: collections?.length ?? 0,
    recipes: recipesFetched.length,
    ingredients: ingTotal,
    instructions: stepTotal,
    importBatches: importCounts.batches,
    importItems: importCounts.items,
    importItemAttempts: importCounts.attempts,
    importTocEntries: importCounts.tocEntries,
  };
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
  const counts: ImportPullCounts = { batches: 0, items: 0, attempts: 0, tocEntries: 0 };

  const batchTopic = `import_batches:${ownerId}`;
  const batchSince = new Date(await getWatermark(batchTopic)).toISOString();
  const batchRes = await client
    .from('import_batches')
    .select('*')
    .eq('owner_id', ownerId)
    .gte('updated_at', batchSince)
    .order('updated_at', { ascending: true });
  if (batchRes.error) throw batchRes.error;
  let maxBatchTs = await getWatermark(batchTopic);
  for (const row of batchRes.data ?? []) {
    await upsertImportBatchRow(row as ImportBatchRow);
    maxBatchTs = Math.max(maxBatchTs, toMs((row as ImportBatchRow).updated_at));
    counts.batches += 1;
  }
  if (maxBatchTs > 0) await bumpWatermark(batchTopic, maxBatchTs);

  const itemTopic = `import_items:${ownerId}`;
  const itemSince = new Date(await getWatermark(itemTopic)).toISOString();
  const itemRes = await client
    .from('import_items')
    .select('*')
    .eq('owner_id', ownerId)
    .gte('updated_at', itemSince)
    .order('updated_at', { ascending: true });
  if (itemRes.error) throw itemRes.error;
  let maxItemTs = await getWatermark(itemTopic);
  for (const row of itemRes.data ?? []) {
    await upsertImportItemRow(row as ImportItemRow);
    maxItemTs = Math.max(maxItemTs, toMs((row as ImportItemRow).updated_at));
    counts.items += 1;
  }
  if (maxItemTs > 0) await bumpWatermark(itemTopic, maxItemTs);

  // Attempts are append-only on the server (no updated_at). Watermark on
  // started_at instead so each pull only fetches new rows.
  const attemptTopic = `import_item_attempts:${ownerId}`;
  const attemptSince = new Date(await getWatermark(attemptTopic)).toISOString();
  const attemptRes = await client
    .from('import_item_attempts')
    .select('*')
    .eq('owner_id', ownerId)
    .gte('started_at', attemptSince)
    .order('started_at', { ascending: true });
  if (attemptRes.error) throw attemptRes.error;
  let maxAttemptTs = await getWatermark(attemptTopic);
  for (const row of attemptRes.data ?? []) {
    await upsertImportItemAttemptRow(row as ImportItemAttemptRow);
    maxAttemptTs = Math.max(maxAttemptTs, toMs((row as ImportItemAttemptRow).started_at));
    counts.attempts += 1;
  }
  if (maxAttemptTs > 0) await bumpWatermark(attemptTopic, maxAttemptTs);

  const tocTopic = `import_toc_entries:${ownerId}`;
  const tocSince = new Date(await getWatermark(tocTopic)).toISOString();
  const tocRes = await client
    .from('import_toc_entries')
    .select('*')
    .eq('owner_id', ownerId)
    .gte('updated_at', tocSince)
    .order('updated_at', { ascending: true });
  if (tocRes.error) throw tocRes.error;
  let maxTocTs = await getWatermark(tocTopic);
  for (const row of tocRes.data ?? []) {
    await upsertImportTocEntryRow(row as ImportTocEntryRow);
    maxTocTs = Math.max(maxTocTs, toMs((row as ImportTocEntryRow).updated_at));
    counts.tocEntries += 1;
  }
  if (maxTocTs > 0) await bumpWatermark(tocTopic, maxTocTs);

  return counts;
}

// ---------- local upserts for import rows ----------

async function upsertImportBatchRow(row: ImportBatchRow): Promise<void> {
  const db = await getLocalDb();
  const ts = toMs(row.updated_at);
  await db.exec(
    `insert into import_batches
       (id, owner_id, name, source_kind, target_collection_id,
        default_model, default_provider, fallback_model, fallback_provider,
        recitation_policy, status, total_items, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,0)
     on conflict(id) do update set
       owner_id=excluded.owner_id,
       name=excluded.name,
       source_kind=excluded.source_kind,
       target_collection_id=excluded.target_collection_id,
       default_model=excluded.default_model,
       default_provider=excluded.default_provider,
       fallback_model=excluded.fallback_model,
       fallback_provider=excluded.fallback_provider,
       recitation_policy=excluded.recitation_policy,
       status=excluded.status,
       total_items=excluded.total_items,
       updated_at=excluded.updated_at,
       deleted=0
     where excluded.updated_at >= import_batches.updated_at`,
    [
      row.id,
      row.owner_id,
      row.name,
      row.source_kind,
      row.target_collection_id,
      row.default_model,
      row.default_provider,
      row.fallback_model,
      row.fallback_provider,
      row.recitation_policy,
      row.status,
      row.total_items,
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
  await db.exec(
    `insert into import_items
       (id, batch_id, owner_id, page_index, storage_path, thumb_path,
        source_pdf_path, source_pdf_page,
        assigned_collection_id, assigned_page_number, is_toc, status,
        claim_expires_at, attempts, last_error, parsed_drafts_json,
        model_used, prompt_tokens, completion_tokens, cost_usd_micros,
        created_recipe_ids, needs_fallback, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
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
       needs_fallback=excluded.needs_fallback,
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
      row.needs_fallback ? 1 : 0,
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

export function subscribeRealtime(
  client: CookbooksClient,
  ownerId: string,
  onChange: () => void,
): RealtimeHandle {
  const channel: RealtimeChannel = client
    .channel(`cyb:${ownerId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipe_collections', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleCollectionEvent(payload);
        onChange();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'recipes' },
      async (payload) => {
        await handleRecipeEvent(client, payload);
        onChange();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ingredients' },
      async () => {
        // Ingredients don't carry owner info; piggy-back on the recipe's
        // next refresh instead of doing a broad refetch per event.
        onChange();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'instructions' },
      async () => {
        onChange();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'import_batches', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleImportBatchEvent(payload);
        onChange();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'import_items', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleImportItemEvent(payload);
        onChange();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'import_item_attempts', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleImportAttemptEvent(payload);
        onChange();
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'import_toc_entries', filter: `owner_id=eq.${ownerId}` },
      async (payload) => {
        await handleImportTocEvent(payload);
        onChange();
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

// ---------- push ----------

export async function pushOutbox(
  client: CookbooksClient,
  ownerId: string,
): Promise<{ ok: number; failed: number }> {
  const pending = await listPending();
  let ok = 0;
  let failed = 0;
  for (const entry of pending) {
    try {
      await pushOne(client, ownerId, entry);
      await markDone(entry.id);
      ok += 1;
    } catch (err) {
      await markFailed(entry.id, (err as Error).message);
      failed += 1;
      // Stop on first failure so we don't batter the server with a broken
      // entry; the caller's retry schedule will pick it up.
      break;
    }
  }
  return { ok, failed };
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
  const payload: BatchInsert = {
    id: local.id as string,
    owner_id: local.owner_id as string,
    name: local.name as string,
    source_kind: local.source_kind as 'IMAGES' | 'PDF',
    target_collection_id: (local.target_collection_id as string | null) ?? null,
    default_model: local.default_model as string,
    default_provider: local.default_provider as 'gemini' | 'openai-compatible',
    fallback_model: (local.fallback_model as string | null) ?? null,
    fallback_provider:
      (local.fallback_provider as 'gemini' | 'openai-compatible' | null) ?? null,
    status: local.status as 'OPEN' | 'ARCHIVED',
  };
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
    is_toc: local.is_toc === 1 || local.is_toc === true,
  };
  const { error } = await client
    .from('import_items')
    .upsert(payload, { onConflict: 'id' });
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
  type ItemUpdate = Database['public']['Tables']['import_items']['Update'];
  const payload: ItemUpdate = {
    assigned_collection_id: (local.assigned_collection_id as string | null) ?? null,
    assigned_page_number: (local.assigned_page_number as number | null) ?? null,
    is_toc: local.is_toc === 1 || local.is_toc === true,
    created_recipe_ids: createdIds,
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
  const recipePayload = {
    ...recipeRow,
    collection_id: collectionId,
    equipment: parseJsonField((recipeRow as { equipment?: unknown }).equipment),
    page_numbers: parseJsonField((recipeRow as { page_numbers?: unknown }).page_numbers),
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
