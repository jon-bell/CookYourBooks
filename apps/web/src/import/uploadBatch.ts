import { supabase } from '../supabase.js';
import { kickOcr } from './api.js';
import { prepareImage, renderPdfToJpegs, type PreparedPage } from './imageProcessing.js';
import { enqueue } from '../local/outbox.js';
import { getLocalDb } from '../local/db.js';
import type { OcrProvider, SourceKind, BatchKind } from './model.js';
import type { BakeoffVariantInput } from './api.js';
import { type PageMarker, DEFAULT_MARKER, planPageGroups } from './pageMarker.js';

export interface UploadBatchInput {
  ownerId: string;
  name: string;
  targetCollectionId: string | null;
  defaultProvider: OcrProvider;
  defaultModel: string;
  /** Snapshotted onto the batch so the worker uses it instead of the
   *  built-in RECIPE_PROMPT. Null/empty => worker falls back to RECIPE_PROMPT. */
  defaultPrompt?: string | null;
  fallbackProvider: OcrProvider | null;
  fallbackModel: string | null;
  /** Set when the effective OCR config came from the household (the member
   *  whose Vault key/account is borrowed). Null => own key. */
  keyOwnerId?: string | null;
  sourceKind: SourceKind;
  files: File[];
  /** Optional per-file capture markers, index-aligned with `files`. Absent =>
   *  every file is a RECIPE page with no continuation. A `joinsPrevious` marker
   *  folds that page into the previous leader's `extra_storage_paths` so the
   *  multi-page recipe OCRs in one call. Ignored for PDF inputs (one file →
   *  many pages). */
  markers?: PageMarker[];
  batchKind?: BatchKind;
  /** Required when batchKind is BAKEOFF. Seeded server-side after upload. */
  bakeoffVariants?: readonly BakeoffVariantInput[];
  /** When true, items land in AWAITING_GROUPING and the worker is not
   *  kicked. Caller must drive the user through grouping and then call
   *  `import_finalize_grouping` to release items into PENDING. */
  awaitGrouping?: boolean;
}

export interface UploadProgress {
  phase: 'preparing' | 'uploading' | 'finalizing' | 'done';
  done: number;
  total: number;
  message?: string;
}

export interface UploadBatchResult {
  batchId: string;
  itemIds: string[];
  batchKind: BatchKind;
}

/** A page that becomes its own import_items row. Continuation pages don't get
 *  their own row — their storage path is folded into the leader's
 *  `extraStoragePaths`, matching the worker's multi-image OCR contract. */
interface LeaderItem {
  id: string;
  pageIndex: number;
  page: PreparedPage;
  marker: PageMarker;
  extraStoragePaths: string[];
}

async function uploadBlob(path: string, blob: Blob): Promise<void> {
  const { error } = await supabase.storage.from('imports').upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) throw error;
}

/**
 * Upload a single image for the bakeoff page. Reuses the imports bucket
 * + RLS — bakeoff blobs live under `<ownerId>/bakeoffs/<uuid>.jpg` so the
 * existing per-owner folder policy keeps them isolated.
 */
export async function uploadBakeoffImage(
  ownerId: string,
  file: File,
): Promise<string> {
  const prepared = await prepareImage(file);
  const path = `${ownerId}/bakeoffs/${crypto.randomUUID()}.jpg`;
  await uploadBlob(path, prepared.fullJpeg);
  return path;
}

/**
 * Drive the full create-batch pipeline: prepare images (or split a PDF),
 * upload page + thumb blobs, insert the batch row + item rows, and call
 * `kickOcr` so the worker starts draining.
 */
export async function uploadBatch(
  input: UploadBatchInput,
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadBatchResult> {
  // Step 1: Prepare all pages (decode images / render PDFs).
  onProgress?.({ phase: 'preparing', done: 0, total: input.files.length });
  const markers = input.markers;
  const preparedWithMarker: { page: PreparedPage; marker: PageMarker }[] = [];
  let prepDone = 0;
  for (let fi = 0; fi < input.files.length; fi += 1) {
    const file = input.files[fi]!;
    const marker = markers?.[fi] ?? DEFAULT_MARKER;
    if (
      input.sourceKind === 'PDF' ||
      file.type === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf')
    ) {
      const pages = await renderPdfToJpegs(file, (d, t) => {
        onProgress?.({
          phase: 'preparing',
          done: prepDone,
          total: input.files.length,
          message: `Splitting PDF page ${d} of ${t}`,
        });
      });
      // PDF pages can't carry capture-time markers; default each to RECIPE.
      for (const p of pages) preparedWithMarker.push({ page: p, marker: DEFAULT_MARKER });
    } else {
      preparedWithMarker.push({ page: await prepareImage(file), marker });
    }
    prepDone += 1;
    onProgress?.({ phase: 'preparing', done: prepDone, total: input.files.length });
  }

  // Step 2: Allocate IDs locally so we can write storage at predictable paths.
  const batchId = crypto.randomUUID();

  // One id per prepared page — every page uploads a blob, leader or merged-in.
  const pages = preparedWithMarker.map((pm) => ({
    id: crypto.randomUUID(),
    page: pm.page,
    marker: pm.marker,
  }));

  // Group continuations (pure, unit-tested): a `joinsPrevious` page folds into
  // the previous leader's extra_storage_paths instead of becoming its own
  // import_item, so a multi-page recipe OCRs together. page_index / total_items
  // count leaders only.
  const pageById = new Map<string, (typeof pages)[number]>(pages.map((p) => [p.id, p]));
  const leaders: LeaderItem[] = planPageGroups(pages).map((g) => {
    const leaderPage = pageById.get(g.leaderId)!;
    return {
      id: g.leaderId,
      pageIndex: g.pageIndex,
      page: leaderPage.page,
      marker: leaderPage.marker,
      extraStoragePaths: g.extraIds.map((id) => `${input.ownerId}/${batchId}/pages/${id}.jpg`),
    };
  });

  // Step 3: Upload each page + thumb with bounded concurrency. All JPEG blobs
  // were materialized in Step 1, so parallel uploads cost network buffers only.
  // First failure rejects the pool (fail-fast, same as the old sequential loop);
  // stray in-flight uploads are harmless (upsert + no DB rows written yet).
  const total = pages.length;
  let completed = 0;
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= pages.length) return;
      const p = pages[i]!;
      await uploadBlob(`${input.ownerId}/${batchId}/pages/${p.id}.jpg`, p.page.fullJpeg);
      await uploadBlob(`${input.ownerId}/${batchId}/thumbs/${p.id}.jpg`, p.page.thumbJpeg);
      completed += 1;
      onProgress?.({ phase: 'uploading', done: completed, total });
    }
  };
  const CONCURRENCY = 5;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker));

  // Step 4: Insert the batch + item rows locally and enqueue an outbox
  // push so a network blip after Step 3 doesn't strand the metadata.
  onProgress?.({ phase: 'finalizing', done: 0, total: 1 });
  const db = await getLocalDb();
  const now = Date.now();
  await db.exec(
    `insert into import_batches
       (id, owner_id, name, batch_kind, source_kind, target_collection_id,
        default_model, default_provider, default_prompt, fallback_model, fallback_provider,
        key_owner_id, recitation_policy, status, total_items, is_planner, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [
      batchId,
      input.ownerId,
      input.name,
      input.batchKind ?? 'STANDARD',
      input.sourceKind,
      input.targetCollectionId,
      input.defaultModel,
      input.defaultProvider,
      input.defaultPrompt?.trim() || null,
      input.fallbackModel,
      input.fallbackProvider,
      input.keyOwnerId ?? null,
      'ASK',
      'OPEN',
      leaders.length,
      0,
      now,
    ],
  );
  await enqueue({ kind: 'import_batch_insert', entity_id: batchId });

  const isBakeoff = input.batchKind === 'BAKEOFF';
  const initialStatus = input.awaitGrouping
    ? 'AWAITING_GROUPING'
    : isBakeoff
      ? 'BAKEOFF_PENDING'
      : 'PENDING';
  for (const leader of leaders) {
    const storagePath = `${input.ownerId}/${batchId}/pages/${leader.id}.jpg`;
    const thumbPath = `${input.ownerId}/${batchId}/thumbs/${leader.id}.jpg`;
    await db.exec(
      `insert into import_items
         (id, batch_id, owner_id, page_index, storage_path, thumb_path,
          source_pdf_path, source_pdf_page,
          assigned_collection_id, assigned_page_number, assigned_recipe_id,
          is_toc, kind, status,
          claim_expires_at, attempts, last_error, parsed_drafts_json,
          model_used, prompt_tokens, completion_tokens, cost_usd_micros,
          created_recipe_ids, needs_fallback, extra_storage_paths,
          updated_at, deleted)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        leader.id,
        batchId,
        input.ownerId,
        leader.pageIndex,
        storagePath,
        thumbPath,
        null,
        leader.page.sourcePdfPage ?? null,
        input.targetCollectionId,
        null,
        null,
        leader.marker.kind === 'TOC' ? 1 : 0,
        leader.marker.kind,
        initialStatus,
        0,
        0,
        null,
        null,
        null,
        0,
        0,
        0,
        '[]',
        0,
        JSON.stringify(leader.extraStoragePaths),
        now,
      ],
    );
    await enqueue({ kind: 'import_item_insert', entity_id: leader.id });
  }

  // Step 5: Nudge the worker — bakeoff batches need variant seeding first;
  // group-first batches need grouping before OCR starts.
  if (!input.awaitGrouping && !isBakeoff) {
    try {
      await kickOcr(batchId);
    } catch {
      // Kick is best-effort — pg_cron's 30s tick will still pick the batch up.
    }
  }
  onProgress?.({ phase: 'done', done: total, total });
  return { batchId, itemIds: leaders.map((l) => l.id), batchKind: input.batchKind ?? 'STANDARD' };
}
