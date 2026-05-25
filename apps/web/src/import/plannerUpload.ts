// Per-shot upload pipeline for the Speed Importer.
//
// The /import/new wizard uploads a single bulk batch up front; the
// planner is the opposite — every shutter is its own transaction.
// `ensurePlannerBatch` lazily mints a batch row on the first shot;
// `addPlannedShot` prepares + uploads + inserts one item;
// `finalizePlannerSession` walks the local items, groups them by
// `assigned_recipe_id`, and hands the result to the existing
// `import_finalize_grouping` RPC so the worker takes over.

import { supabase } from '../supabase.js';
import { kickOcr, finalizeGrouping } from './api.js';
import { getLocalDb } from '../local/db.js';
import {
  findOpenPlannerSession,
  insertLocalPlannerBatch,
  insertLocalPlannerItem,
  LocalImportItemRepository,
} from './localRepos.js';
import { prepareImage } from './imageProcessing.js';
import { resolveImportFallback } from '../settings/FallbackModelSection.js';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  loadOcrSettings,
} from '../settings/ocrSettings.js';
import type {
  ImportBatch,
  ImportItem,
  OcrProvider,
} from './model.js';

async function uploadBlob(path: string, blob: Blob): Promise<void> {
  const { error } = await supabase.storage.from('imports').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) throw error;
}

interface OcrDefaults {
  provider: OcrProvider;
  model: string;
}

/**
 * Resolve OCR provider/model defaults the same way ImportNewPage does:
 * user's saved settings win, otherwise pick the first registered key
 * provider, otherwise fall back to Gemini. The planner never asks the
 * user about provider/model — keeping settings off the critical path
 * is part of "extremely performant".
 */
function resolveOcrDefaults(
  registeredProviders: readonly string[],
): OcrDefaults {
  const saved = loadOcrSettings();
  if (saved) {
    return { provider: saved.provider, model: saved.model };
  }
  const first = registeredProviders[0];
  if (first === 'gemini' || first === 'openai-compatible') {
    return { provider: first, model: DEFAULT_MODEL_BY_PROVIDER[first] };
  }
  return {
    provider: 'gemini',
    model: DEFAULT_MODEL_BY_PROVIDER.gemini,
  };
}

/**
 * Return the user's open Speed Importer session for this cookbook,
 * creating one if absent. Idempotent — concurrent calls during the
 * first-shutter race resolve to the same batch row because the second
 * call will see the row the first call just inserted.
 *
 * `registeredProviders` lets the lazy-create path pick a sensible
 * default model without needing the caller to fetch OCR keys
 * themselves; pass `useOcrKeys().data?.map(k => k.provider) ?? []`.
 */
export async function ensurePlannerBatch(
  ownerId: string,
  collectionId: string,
  collectionTitle: string,
  registeredProviders: readonly string[],
): Promise<ImportBatch> {
  const existing = await findOpenPlannerSession(ownerId, collectionId);
  if (existing) return existing;

  const defaults = resolveOcrDefaults(registeredProviders);
  const { fallbackProvider, fallbackModel } = resolveImportFallback();
  const now = Date.now();
  const batch: ImportBatch = {
    id: crypto.randomUUID(),
    ownerId,
    name: `Speed Importer · ${collectionTitle}`,
    sourceKind: 'IMAGES',
    targetCollectionId: collectionId,
    defaultModel: defaults.model,
    defaultProvider: defaults.provider,
    fallbackModel,
    fallbackProvider,
    recitationPolicy: 'ASK',
    status: 'OPEN',
    totalItems: 0,
    // Planner sessions are a regular STANDARD import; the is_planner
    // boolean is what /import/speed keys off, not the bakeoff-as-import
    // batch_kind discriminator.
    batchKind: 'STANDARD',
    isPlanner: true,
    updatedAt: now,
  };
  await insertLocalPlannerBatch(batch);
  return batch;
}

export interface PlannedShotTarget {
  recipeId: string;
  collectionId: string;
  /** First page number from the placeholder's `pageNumbers`, if any.
   *  Stored on the import_items row so the OCR result inherits the
   *  ToC-known page when the model's own extraction is blank. */
  pageNumber: number | null;
}

/**
 * Process a single captured photo end-to-end:
 *   1. Decode + resize (full + thumb) via the shared imageProcessing helper.
 *   2. Upload full + thumb blobs to Storage under the canonical
 *      `<owner>/<batch>/{pages,thumbs}/<item>.jpg` paths so the rest
 *      of the import UI (signed-URL viewer, thumb loader) needs no
 *      planner-specific casing.
 *   3. Insert an `import_items` row locally in AWAITING_GROUPING with
 *      assignedRecipeId pre-set, enqueue the outbox push.
 *
 * Page index is the count of existing items in the batch — strictly
 * increasing, used to preserve capture order across recipes (the
 * finalize step sorts within each recipe by page_index).
 */
export async function addPlannedShot(
  batch: ImportBatch,
  target: PlannedShotTarget,
  file: File,
): Promise<{ itemId: string }> {
  const prepared = await prepareImage(file);
  const itemId = crypto.randomUUID();
  const fullPath = `${batch.ownerId}/${batch.id}/pages/${itemId}.jpg`;
  const thumbPath = `${batch.ownerId}/${batch.id}/thumbs/${itemId}.jpg`;
  await uploadBlob(fullPath, prepared.fullJpeg);
  await uploadBlob(thumbPath, prepared.thumbJpeg);

  const db = await getLocalDb();
  // page_index = current item count in the batch. We don't lock —
  // single-user, single-tab is the realistic shape, and a collision
  // would only mean two shots share a page_index, which the
  // finalize-side sort handles gracefully.
  const rows = (await db.execO<{ c: number }>(
    `select count(*) as c from import_items where batch_id = ? and deleted = 0`,
    [batch.id],
  )) as { c: number }[];
  const pageIndex = rows[0]?.c ?? 0;

  const item: ImportItem = {
    id: itemId,
    batchId: batch.id,
    ownerId: batch.ownerId,
    pageIndex,
    storagePath: fullPath,
    thumbPath,
    sourcePdfPath: null,
    sourcePdfPage: null,
    assignedCollectionId: target.collectionId,
    assignedPageNumber: target.pageNumber,
    assignedRecipeId: target.recipeId,
    isToc: false,
    status: 'AWAITING_GROUPING',
    claimExpiresAt: 0,
    attempts: 0,
    lastError: null,
    parsedDrafts: [],
    modelUsed: null,
    promptTokens: 0,
    completionTokens: 0,
    costUsdMicros: 0,
    createdRecipeIds: [],
    selectedVariantId: null,
    extraStoragePaths: [],
    updatedAt: Date.now(),
  };
  await insertLocalPlannerItem(item);
  // Bump the batch's total_items so the existing batch board's
  // progress widgets read correctly.
  await db.exec(
    `update import_batches set total_items = total_items + 1, updated_at = ? where id = ?`,
    [Date.now(), batch.id],
  );
  return { itemId };
}

/**
 * Mark a captured shot as DISCARDED — used by the planner's retake /
 * remove actions. The Storage object is left in place (cheap, and the
 * worker never sees DISCARDED rows so they don't drive cost).
 */
export async function discardPlannedShot(
  ownerId: string,
  itemId: string,
): Promise<void> {
  await new LocalImportItemRepository(ownerId).update(itemId, {
    status: 'DISCARDED',
  });
}

/**
 * Hand the planner session off to the existing bulk-OCR pipeline.
 * Walks AWAITING_GROUPING items for the batch, groups them by
 * `assignedRecipeId`, sorts each group by `pageIndex` (= upload
 * order), and calls `import_finalize_grouping` with the canonical
 * `[[primary, ...absorbs], …]` payload. Items absorbed inside a group
 * become DISCARDED + their storage_path appended to the primary's
 * extras (the RPC does both atomically). Remaining primaries flip to
 * PENDING and the worker takes over.
 *
 * Items without an assignedRecipeId (shouldn't happen for the planner
 * but possible if the user manually intervened) are passed through as
 * singletons so they don't block the rest.
 */
export async function finalizePlannerSession(
  ownerId: string,
  batchId: string,
): Promise<{ recipeCount: number }> {
  const items = await new LocalImportItemRepository(ownerId).listByBatch(batchId);
  const awaiting = items.filter((i) => i.status === 'AWAITING_GROUPING');
  if (awaiting.length === 0) {
    return { recipeCount: 0 };
  }
  const byRecipe = new Map<string, typeof awaiting>();
  const singletons: typeof awaiting = [];
  for (const it of awaiting) {
    if (!it.assignedRecipeId) {
      singletons.push(it);
      continue;
    }
    const list = byRecipe.get(it.assignedRecipeId) ?? [];
    list.push(it);
    byRecipe.set(it.assignedRecipeId, list);
  }
  const groups: string[][] = [];
  for (const list of byRecipe.values()) {
    const sorted = [...list].sort((a, b) => a.pageIndex - b.pageIndex);
    groups.push(sorted.map((i) => i.id));
  }
  for (const i of singletons) groups.push([i.id]);

  await finalizeGrouping(batchId, groups);
  // Kick is best-effort — pg_cron will pick up PENDING rows within 30s
  // either way.
  try {
    await kickOcr(batchId);
  } catch {
    // ignored
  }
  return { recipeCount: groups.length };
}
