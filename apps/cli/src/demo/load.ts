import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { collectionToInsert, type Json, recipeToInsert } from '@cookyourbooks/db';
import {
  buildRecipeFromDraft,
  createCookbook,
  createPersonalCollection,
  isDraftAutoAcceptable,
  type ParsedRecipeDraft,
} from '@cookyourbooks/domain';

import type { DemoBook } from './corpus.js';
import type { DemoClient } from './session.js';

// `cyb demo load`: push a demo-content corpus through the real OCR import
// pipeline — the same Storage layout, import_batches / import_items rows and
// worker the app's "Choose images" flow uses — then promote the clean drafts
// with the app's own auto-accept bar (isDraftAutoAcceptable). One batch per
// book, one import item per recipe (continuation pages ride along as
// extra_storage_paths so a recipe that crosses a page break OCRs in one call).
//
// Re-runnable: a book whose batch already exists isn't uploaded again — the
// run resumes it (waits for pending pages, promotes what's ready). Promotion
// overwrites a same-titled recipe in the cookbook instead of duplicating it.

export interface LoadOptions {
  /** Cap on recipes per book (after sorting by folder name). */
  maxRecipes?: number;
  /** Promote auto-acceptable drafts to recipes (default true). */
  accept: boolean;
  /** Wait for the worker at all (default true). */
  wait: boolean;
  /** Give up waiting on one book after this long. */
  timeoutMs: number;
  /** Upload again even if the book's batch exists. */
  force: boolean;
  provider?: 'gemini' | 'openai-compatible';
  model?: string;
  log: (line: string) => void;
}

export interface BookResult {
  book: string;
  batchId: string;
  uploaded: number;
  pending: number;
  failed: number;
  recipesCreated: number;
  heldForReview: number;
}

interface OcrConfig {
  provider: 'gemini' | 'openai-compatible';
  model: string;
  prompt: string | null;
}

const DEFAULT_MODEL = { gemini: 'gemini-3.1-flash-lite', 'openai-compatible': 'gpt-5.4' } as const;
const IN_FLIGHT = new Set(['PENDING', 'CLAIMED']);
const FAILED = new Set(['OCR_FAILED', 'NEEDS_FALLBACK']);

export const batchNameFor = (book: DemoBook) => `Demo · ${book.title}`;

export async function loadBook(
  client: DemoClient,
  userId: string,
  book: DemoBook,
  opts: LoadOptions,
): Promise<BookResult> {
  const recipes = book.recipes.slice(0, opts.maxRecipes ?? book.recipes.length);
  const collectionId = await ensureCollection(client, userId, book);
  const result: BookResult = {
    book: book.id,
    batchId: '',
    uploaded: 0,
    pending: 0,
    failed: 0,
    recipesCreated: 0,
    heldForReview: 0,
  };

  const existing = opts.force ? null : await findBatch(client, batchNameFor(book));
  if (existing) {
    result.batchId = existing;
    opts.log(`  = batch already exists (${existing}) — resuming`);
  } else {
    const config = await resolveOcrConfig(client, opts);
    result.batchId = await uploadBatch(client, userId, book, recipes, collectionId, config, opts);
    result.uploaded = recipes.length;
    const { error } = await client.rpc('ocr_kick', { p_batch_id: result.batchId });
    if (error) {
      // pg_cron's tick still drains the batch; only a missing worker config
      // is worth shouting about.
      opts.log(`  ! ocr_kick: ${error.message}`);
    }
  }

  if (!opts.wait) return result;
  const items = await waitForBatch(client, result.batchId, opts);
  result.pending = items.filter((i) => IN_FLIGHT.has(i.status)).length;
  result.failed = items.filter((i) => FAILED.has(i.status)).length;

  if (opts.accept) {
    const promoted = await promoteBatch(client, collectionId, book, items);
    result.recipesCreated = promoted.created;
    result.heldForReview = promoted.held;
  }
  return result;
}

async function ensureCollection(
  client: DemoClient,
  userId: string,
  book: DemoBook,
): Promise<string> {
  const { data, error } = await client
    .from('recipe_collections')
    .select('id')
    .eq('owner_id', userId)
    .eq('title', book.title)
    .limit(1);
  if (error) throw error;
  if (data[0]) return data[0].id;

  const collection =
    book.collection === 'personal'
      ? createPersonalCollection({ title: book.title })
      : createCookbook({
          title: book.title,
          author: book.author ?? undefined,
          publicationYear: book.year ?? undefined,
        });
  const { error: insertError } = await client
    .from('recipe_collections')
    .insert(collectionToInsert(collection, userId));
  if (insertError) throw insertError;
  return collection.id;
}

async function findBatch(client: DemoClient, name: string): Promise<string | null> {
  const { data, error } = await client
    .from('import_batches')
    .select('id')
    .eq('name', name)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data[0]?.id ?? null;
}

/** The account's own OCR prefs + key, like the app's "effective config" for a
 *  user with their own key. Flags override the saved provider/model. */
async function resolveOcrConfig(client: DemoClient, opts: LoadOptions): Promise<OcrConfig> {
  const [{ data: prefs }, { data: keys, error: keysError }] = await Promise.all([
    client.from('user_ocr_prefs').select('provider, model, prompt').maybeSingle(),
    client.from('user_ocr_keys').select('provider'),
  ]);
  if (keysError) throw keysError;
  const provider = opts.provider ?? (prefs?.provider as OcrConfig['provider'] | undefined);
  if (!provider) {
    throw new Error(
      'This account has no OCR provider set. Configure one in Settings → LLM & models, ' +
        'or pass --provider/--model.',
    );
  }
  if (!keys.some((k) => k.provider === provider)) {
    throw new Error(`This account has no ${provider} API key saved (Settings → LLM & models).`);
  }
  const model =
    opts.model ?? (prefs?.provider === provider && prefs.model ? prefs.model : undefined);
  return {
    provider,
    model: model ?? DEFAULT_MODEL[provider],
    prompt: prefs?.provider === provider ? prefs.prompt : null,
  };
}

async function uploadBatch(
  client: DemoClient,
  userId: string,
  book: DemoBook,
  recipes: DemoBook['recipes'],
  collectionId: string,
  config: OcrConfig,
  opts: LoadOptions,
): Promise<string> {
  const batchId = randomUUID();
  const pagePath = (id: string) => `${userId}/${batchId}/pages/${id}.jpg`;
  const items: {
    id: string;
    pageIndex: number;
    storagePath: string;
    extraStoragePaths: string[];
  }[] = [];

  // Storage first, rows second — the same order as the app, so the worker
  // never claims an item whose image isn't there yet.
  let uploaded = 0;
  const total = recipes.reduce((n, r) => n + r.pages.length, 0);
  for (const [pageIndex, recipe] of recipes.entries()) {
    const paths: string[] = [];
    for (const file of recipe.pages) {
      const path = pagePath(randomUUID());
      const { error } = await client.storage.from('imports').upload(path, readFileSync(file), {
        contentType: 'image/jpeg',
        upsert: true,
      });
      if (error) throw new Error(`upload ${file}: ${error.message}`);
      paths.push(path);
      uploaded += 1;
    }
    const leader = paths[0]!;
    items.push({
      id: leader.slice(leader.lastIndexOf('/') + 1, -'.jpg'.length),
      pageIndex,
      storagePath: leader,
      extraStoragePaths: paths.slice(1),
    });
    opts.log(
      `  ↑ ${recipe.slug} (${recipe.pages.length} page${recipe.pages.length > 1 ? 's' : ''})`,
    );
  }
  opts.log(`  uploaded ${uploaded}/${total} page images`);

  const { error: batchError } = await client.from('import_batches').insert({
    id: batchId,
    owner_id: userId,
    name: batchNameFor(book),
    batch_kind: 'STANDARD',
    source_kind: 'IMAGES',
    target_collection_id: collectionId,
    default_provider: config.provider,
    default_model: config.model,
    default_prompt: config.prompt?.trim() || null,
    status: 'OPEN',
    total_items: items.length,
  });
  if (batchError) throw batchError;

  const { error: itemsError } = await client.from('import_items').insert(
    items.map((i) => ({
      id: i.id,
      batch_id: batchId,
      owner_id: userId,
      page_index: i.pageIndex,
      storage_path: i.storagePath,
      // No image library in the CLI; the board thumbnails the full page.
      thumb_path: i.storagePath,
      assigned_collection_id: collectionId,
      kind: 'RECIPE',
      is_toc: false,
      status: 'PENDING',
      extra_storage_paths: i.extraStoragePaths,
    })),
  );
  if (itemsError) throw itemsError;
  opts.log(`  + batch ${batchId} (${items.length} items) queued for OCR`);
  return batchId;
}

interface ItemRow {
  id: string;
  status: string;
  kind: string;
  last_error: string | null;
  parsed_drafts_json: Json | null;
  created_recipe_ids: string[];
}

async function waitForBatch(
  client: DemoClient,
  batchId: string,
  opts: LoadOptions,
): Promise<ItemRow[]> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastLine = '';
  for (;;) {
    const { data, error } = await client
      .from('import_items')
      .select('id, status, kind, last_error, parsed_drafts_json, created_recipe_ids')
      .eq('batch_id', batchId)
      .order('page_index');
    if (error) throw error;
    const items = data as ItemRow[];
    const inFlight = items.filter((i) => IN_FLIGHT.has(i.status)).length;
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
    const line = [...counts].map(([s, n]) => `${n} ${s.toLowerCase()}`).join(', ');
    if (line !== lastLine) {
      opts.log(`  … ${line}`);
      lastLine = line;
    }
    if (inFlight === 0) return items;
    if (Date.now() > deadline) {
      opts.log(`  ! gave up waiting with ${inFlight} page(s) still in the OCR queue`);
      return items;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const normTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Promote every auto-acceptable draft on the batch's OCR_DONE recipe items.
 *  Mirrors the batch board's auto-accept pass: accepted drafts leave the item,
 *  weak ones stay for review, and the item closes (REVIEWED) once empty. */
async function promoteBatch(
  client: DemoClient,
  collectionId: string,
  book: DemoBook,
  items: ItemRow[],
): Promise<{ created: number; held: number }> {
  const { data: existing, error } = await client
    .from('recipes')
    .select('id, title, sort_order')
    .eq('collection_id', collectionId);
  if (error) throw error;
  const byTitle = new Map(existing.map((r) => [normTitle(r.title), r.id]));
  let sortOrder = existing.reduce((m, r) => Math.max(m, r.sort_order + 1), 0);

  let created = 0;
  let held = 0;
  for (const item of items) {
    if (item.status !== 'OCR_DONE' || item.kind !== 'RECIPE') continue;
    const drafts = Array.isArray(item.parsed_drafts_json)
      ? (item.parsed_drafts_json as unknown as ParsedRecipeDraft[])
      : [];
    const accepted: ParsedRecipeDraft[] = [];
    const remaining: ParsedRecipeDraft[] = [];
    for (const d of drafts)
      (isDraftAutoAcceptable(normalizeDraft(d)) ? accepted : remaining).push(d);
    held += remaining.length;
    if (accepted.length === 0) continue;

    const rows = accepted.map((draft) => {
      const title = draft.title?.trim() ?? '';
      const recipe = buildRecipeFromDraft(normalizeDraft(draft), {
        collectionTitle: book.title,
        recipeId: byTitle.get(normTitle(title)),
      });
      byTitle.set(normTitle(recipe.title), recipe.id);
      // The RPC derives has_content itself (and rejects nothing else here).
      const { has_content: _hc, ...row } = recipeToInsert(recipe, collectionId, sortOrder++);
      return { recipe: row };
    });
    const { error: saveError } = await client.rpc('save_recipes_graph', {
      p_recipes: rows as unknown as Json,
    });
    if (saveError) throw saveError;
    created += rows.length;

    const { error: itemError } = await client
      .from('import_items')
      .update({
        parsed_drafts_json: remaining as unknown as Json,
        created_recipe_ids: [...item.created_recipe_ids, ...rows.map((r) => r.recipe.id!)],
        assigned_collection_id: collectionId,
        ...(remaining.length === 0 ? { status: 'REVIEWED' } : {}),
      })
      .eq('id', item.id);
    if (itemError) throw itemError;
  }
  return { created, held };
}

/** Worker drafts are domain-shaped JSON, but older rows can lack the array
 *  fields the auto-accept bar reads; default them rather than crash. */
function normalizeDraft(d: ParsedRecipeDraft): ParsedRecipeDraft {
  const raw: Partial<ParsedRecipeDraft> = d;
  return {
    ...d,
    ingredients: raw.ingredients ?? [],
    instructions: raw.instructions ?? [],
    leftover: raw.leftover ?? [],
  };
}
