import { supabase } from '../supabase.js';
import { kickOcr } from './api.js';
import { prepareImage, renderPdfToJpegs, type PreparedPage } from './imageProcessing.js';
import { enqueue } from '../local/outbox.js';
import { getLocalDb } from '../local/db.js';
import type { OcrProvider, SourceKind } from './model.js';

export interface UploadBatchInput {
  ownerId: string;
  name: string;
  targetCollectionId: string | null;
  defaultProvider: OcrProvider;
  defaultModel: string;
  fallbackProvider: OcrProvider | null;
  fallbackModel: string | null;
  sourceKind: SourceKind;
  files: File[];
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
  const prepared: PreparedPage[] = [];
  let prepDone = 0;
  for (const file of input.files) {
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
      prepared.push(...pages);
    } else {
      prepared.push(await prepareImage(file));
    }
    prepDone += 1;
    onProgress?.({ phase: 'preparing', done: prepDone, total: input.files.length });
  }

  // Step 2: Allocate IDs locally so we can write storage at predictable paths.
  const batchId = crypto.randomUUID();
  const items = prepared.map((p, i) => ({
    id: crypto.randomUUID(),
    pageIndex: i,
    sourcePdfPage: p.sourcePdfPage ?? null,
    page: p,
  }));

  // Step 3: Upload each page + thumb. Sequential upload keeps memory
  // pressure low for huge batches (100+ pages) and gives a steady
  // progress signal.
  const total = items.length;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const fullPath = `${input.ownerId}/${batchId}/pages/${item.id}.jpg`;
    const thumbPath = `${input.ownerId}/${batchId}/thumbs/${item.id}.jpg`;
    await uploadBlob(fullPath, item.page.fullJpeg);
    await uploadBlob(thumbPath, item.page.thumbJpeg);
    onProgress?.({ phase: 'uploading', done: i + 1, total });
  }

  // Step 4: Insert the batch + item rows locally and enqueue an outbox
  // push so a network blip after Step 3 doesn't strand the metadata.
  onProgress?.({ phase: 'finalizing', done: 0, total: 1 });
  const db = await getLocalDb();
  const now = Date.now();
  await db.exec(
    `insert into import_batches
       (id, owner_id, name, source_kind, target_collection_id,
        default_model, default_provider, fallback_model, fallback_provider,
        recitation_policy, status, total_items, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [
      batchId,
      input.ownerId,
      input.name,
      input.sourceKind,
      input.targetCollectionId,
      input.defaultModel,
      input.defaultProvider,
      input.fallbackModel,
      input.fallbackProvider,
      'ASK',
      'OPEN',
      items.length,
      now,
    ],
  );
  await enqueue({ kind: 'import_batch_insert', entity_id: batchId });

  const initialStatus = input.awaitGrouping ? 'AWAITING_GROUPING' : 'PENDING';
  for (const it of items) {
    const storagePath = `${input.ownerId}/${batchId}/pages/${it.id}.jpg`;
    const thumbPath = `${input.ownerId}/${batchId}/thumbs/${it.id}.jpg`;
    await db.exec(
      `insert into import_items
         (id, batch_id, owner_id, page_index, storage_path, thumb_path,
          source_pdf_path, source_pdf_page,
          assigned_collection_id, assigned_page_number, is_toc, status,
          claim_expires_at, attempts, last_error, parsed_drafts_json,
          model_used, prompt_tokens, completion_tokens, cost_usd_micros,
          created_recipe_ids, needs_fallback, extra_storage_paths,
          updated_at, deleted)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        it.id,
        batchId,
        input.ownerId,
        it.pageIndex,
        storagePath,
        thumbPath,
        null,
        it.sourcePdfPage,
        input.targetCollectionId,
        null,
        0,
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
        '[]',
        now,
      ],
    );
    await enqueue({ kind: 'import_item_insert', entity_id: it.id });
  }

  // Step 5: Nudge the worker — unless this batch is awaiting grouping,
  // in which case the user still has to decide which pages go together
  // and `import_finalize_grouping` will release rows into PENDING.
  if (!input.awaitGrouping) {
    try {
      await kickOcr(batchId);
    } catch {
      // Kick is best-effort — pg_cron's 30s tick will still pick the batch up.
    }
  }
  onProgress?.({ phase: 'done', done: total, total });
  return { batchId, itemIds: items.map((it) => it.id) };
}
