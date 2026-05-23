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

  return {
    collections: collections?.length ?? 0,
    recipes: recipesFetched.length,
    ingredients: ingTotal,
    instructions: stepTotal,
  };
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
  }
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
