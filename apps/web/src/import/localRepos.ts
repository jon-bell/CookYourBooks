import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import { getLocalDb } from '../local/db.js';
import { enqueue } from '../local/outbox.js';
import type {
  ImportBatch,
  ImportItem,
  ImportItemAttempt,
  ImportItemStatus,
  ImportTocEntry,
} from './model.js';
import type { PageKind } from './pageMarker.js';

interface ImportBatchSqlRow {
  id: string;
  owner_id: string;
  name: string;
  batch_kind: string;
  source_kind: string;
  target_collection_id: string | null;
  default_model: string;
  default_provider: string;
  fallback_model: string | null;
  fallback_provider: string | null;
  recitation_policy: string;
  status: string;
  total_items: number;
  is_planner: number;
  updated_at: number;
  deleted: number;
}

interface ImportItemSqlRow {
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
  is_toc: number;
  kind: string;
  status: string;
  claim_expires_at: number;
  attempts: number;
  last_error: string | null;
  parsed_drafts_json: string | null;
  model_used: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_micros: number;
  created_recipe_ids: string;
  selected_variant_id: string | null;
  extra_storage_paths: string;
  updated_at: number;
  deleted: number;
}

interface ImportItemAttemptSqlRow {
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
  started_at: number;
  finished_at: number | null;
}

interface ImportTocEntrySqlRow {
  id: string;
  batch_id: string;
  item_id: string;
  owner_id: string;
  title: string;
  page_number: number | null;
  confidence: number;
  updated_at: number;
}

function rowToBatch(row: ImportBatchSqlRow): ImportBatch {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    batchKind: (row.batch_kind ?? 'STANDARD') === 'BAKEOFF' ? 'BAKEOFF' : 'STANDARD',
    sourceKind: row.source_kind === 'PDF' ? 'PDF' : 'IMAGES',
    targetCollectionId: row.target_collection_id,
    defaultModel: row.default_model,
    defaultProvider:
      row.default_provider === 'openai-compatible' ? 'openai-compatible' : 'gemini',
    fallbackModel: row.fallback_model,
    fallbackProvider:
      row.fallback_provider === 'openai-compatible'
        ? 'openai-compatible'
        : row.fallback_provider === 'gemini'
          ? 'gemini'
          : null,
    recitationPolicy:
      row.recitation_policy === 'FALLBACK'
        ? 'FALLBACK'
        : row.recitation_policy === 'FAIL'
          ? 'FAIL'
          : 'ASK',
    status: row.status === 'ARCHIVED' ? 'ARCHIVED' : 'OPEN',
    totalItems: row.total_items,
    isPlanner: row.is_planner === 1,
    updatedAt: row.updated_at,
  };
}

function rowToItem(row: ImportItemSqlRow): ImportItem {
  let drafts: ParsedRecipeDraft[] = [];
  if (row.parsed_drafts_json) {
    try {
      const parsed: unknown = JSON.parse(row.parsed_drafts_json);
      if (Array.isArray(parsed)) {
        drafts = parsed as ParsedRecipeDraft[];
      }
    } catch {
      drafts = [];
    }
  }
  let createdRecipeIds: string[] = [];
  if (row.created_recipe_ids) {
    try {
      const parsed: unknown = JSON.parse(row.created_recipe_ids);
      if (Array.isArray(parsed)) {
        createdRecipeIds = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      createdRecipeIds = [];
    }
  }
  let extraStoragePaths: string[] = [];
  if (row.extra_storage_paths) {
    try {
      const parsed: unknown = JSON.parse(row.extra_storage_paths);
      if (Array.isArray(parsed)) {
        extraStoragePaths = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      extraStoragePaths = [];
    }
  }
  return {
    id: row.id,
    batchId: row.batch_id,
    ownerId: row.owner_id,
    pageIndex: row.page_index,
    storagePath: row.storage_path,
    thumbPath: row.thumb_path,
    sourcePdfPath: row.source_pdf_path,
    sourcePdfPage: row.source_pdf_page,
    assignedCollectionId: row.assigned_collection_id,
    assignedPageNumber: row.assigned_page_number,
    assignedRecipeId: row.assigned_recipe_id,
    isToc: row.is_toc === 1,
    // is_toc wins so an existing ToC row (kind defaulted to 'RECIPE' before the
    // server backfill lands) still reads as TOC; otherwise trust `kind`.
    kind: row.is_toc === 1 ? 'TOC' : ((row.kind as PageKind) || 'RECIPE'),
    status: row.status as ImportItemStatus,
    claimExpiresAt: row.claim_expires_at,
    attempts: row.attempts,
    lastError: row.last_error,
    parsedDrafts: drafts,
    modelUsed: row.model_used,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    costUsdMicros: row.cost_usd_micros,
    createdRecipeIds,
    selectedVariantId: row.selected_variant_id ?? null,
    extraStoragePaths,
    updatedAt: row.updated_at,
  };
}

function rowToAttempt(row: ImportItemAttemptSqlRow): ImportItemAttempt {
  return {
    id: row.id,
    itemId: row.item_id,
    ownerId: row.owner_id,
    attemptNo: row.attempt_no,
    provider: row.provider,
    model: row.model,
    rawResponsePath: row.raw_response_path,
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    costUsdMicros: row.cost_usd_micros,
    latencyMs: row.latency_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToToc(row: ImportTocEntrySqlRow): ImportTocEntry {
  return {
    id: row.id,
    batchId: row.batch_id,
    itemId: row.item_id,
    ownerId: row.owner_id,
    title: row.title,
    pageNumber: row.page_number,
    confidence: row.confidence,
    updatedAt: row.updated_at,
  };
}

export class LocalImportBatchRepository {
  constructor(private readonly ownerId: string) {}

  async list(): Promise<ImportBatch[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<ImportBatchSqlRow>(
      `select * from import_batches
       where owner_id = ? and deleted = 0
       order by updated_at desc`,
      [this.ownerId],
    )) as ImportBatchSqlRow[];
    return rows.map(rowToBatch);
  }

  async get(id: string): Promise<ImportBatch | undefined> {
    const db = await getLocalDb();
    const rows = (await db.execO<ImportBatchSqlRow>(
      `select * from import_batches where id = ? and deleted = 0`,
      [id],
    )) as ImportBatchSqlRow[];
    const row = rows[0];
    return row ? rowToBatch(row) : undefined;
  }

  /** Update editable batch fields and queue an outbox push. */
  async update(
    id: string,
    patch: Partial<
      Pick<
        ImportBatch,
        | 'name'
        | 'targetCollectionId'
        | 'recitationPolicy'
        | 'status'
        | 'defaultModel'
        | 'defaultProvider'
        | 'fallbackModel'
        | 'fallbackProvider'
      >
    >,
  ): Promise<void> {
    const db = await getLocalDb();
    const current = await this.get(id);
    if (!current) return;
    const next: ImportBatch = { ...current, ...patch };
    const ts = Date.now();
    await db.exec(
      `update import_batches set
         name = ?, target_collection_id = ?, recitation_policy = ?, status = ?,
         default_model = ?, default_provider = ?, fallback_model = ?, fallback_provider = ?,
         updated_at = ?
       where id = ? and owner_id = ?`,
      [
        next.name,
        next.targetCollectionId,
        next.recitationPolicy,
        next.status,
        next.defaultModel,
        next.defaultProvider,
        next.fallbackModel,
        next.fallbackProvider,
        ts,
        id,
        this.ownerId,
      ],
    );
    await enqueue({ kind: 'import_batch_update', entity_id: id });
  }
}

export class LocalImportItemRepository {
  constructor(private readonly ownerId: string) {}

  async listByBatch(batchId: string): Promise<ImportItem[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<ImportItemSqlRow>(
      `select * from import_items
       where batch_id = ? and owner_id = ? and deleted = 0
       order by page_index asc`,
      [batchId, this.ownerId],
    )) as ImportItemSqlRow[];
    return rows.map(rowToItem);
  }

  async get(id: string): Promise<ImportItem | undefined> {
    const db = await getLocalDb();
    const rows = (await db.execO<ImportItemSqlRow>(
      `select * from import_items where id = ? and deleted = 0`,
      [id],
    )) as ImportItemSqlRow[];
    const row = rows[0];
    return row ? rowToItem(row) : undefined;
  }

  /**
   * Find every import_item whose OCR run produced this recipe.
   * Owner-scoped: a user viewing a public collection they didn't
   * import will get an empty list, which is exactly the gate the
   * recipe page uses to decide whether to show "View original scan".
   *
   * `created_recipe_ids` is stored as a JSON text array. Matching the
   * quoted UUID avoids accidental prefix collisions.
   */
  async listByCreatedRecipeId(recipeId: string): Promise<ImportItem[]> {
    const db = await getLocalDb();
    const needle = `%"${recipeId}"%`;
    const rows = (await db.execO<ImportItemSqlRow>(
      `select * from import_items
       where owner_id = ?
         and deleted = 0
         and created_recipe_ids like ?
       order by page_index asc`,
      [this.ownerId, needle],
    )) as ImportItemSqlRow[];
    return rows.map(rowToItem);
  }

  async listAttempts(itemId: string): Promise<ImportItemAttempt[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<ImportItemAttemptSqlRow>(
      `select * from import_item_attempts where item_id = ?
       order by attempt_no asc`,
      [itemId],
    )) as ImportItemAttemptSqlRow[];
    return rows.map(rowToAttempt);
  }

  async listTocEntries(batchId: string): Promise<ImportTocEntry[]> {
    const db = await getLocalDb();
    const rows = (await db.execO<ImportTocEntrySqlRow>(
      `select * from import_toc_entries where batch_id = ?
       order by page_number asc, title asc`,
      [batchId],
    )) as ImportTocEntrySqlRow[];
    return rows.map(rowToToc);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        ImportItem,
        | 'assignedCollectionId'
        | 'assignedPageNumber'
        | 'assignedRecipeId'
        | 'kind'
        | 'status'
        | 'createdRecipeIds'
        | 'parsedDrafts'
      >
    >,
  ): Promise<void> {
    const db = await getLocalDb();
    const current = await this.get(id);
    if (!current) return;
    const next: ImportItem = { ...current, ...patch };
    const ts = Date.now();
    await db.exec(
      `update import_items set
         assigned_collection_id = ?, assigned_page_number = ?, assigned_recipe_id = ?,
         is_toc = ?, kind = ?, status = ?, parsed_drafts_json = ?, created_recipe_ids = ?,
         updated_at = ?
       where id = ? and owner_id = ?`,
      [
        next.assignedCollectionId,
        next.assignedPageNumber,
        next.assignedRecipeId,
        next.kind === 'TOC' ? 1 : 0,
        next.kind,
        next.status,
        next.parsedDrafts.length > 0 ? JSON.stringify(next.parsedDrafts) : null,
        JSON.stringify(next.createdRecipeIds),
        ts,
        id,
        this.ownerId,
      ],
    );
    await enqueue({ kind: 'import_item_update', entity_id: id });
  }

  /** Locally insert an item row for the shim path (E2E hook). The
   *  status is set to OCR_DONE so the review UI lands on it. */
  async insertLocal(item: ImportItem): Promise<void> {
    const db = await getLocalDb();
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
        item.id,
        item.batchId,
        item.ownerId,
        item.pageIndex,
        item.storagePath,
        item.thumbPath,
        item.sourcePdfPath,
        item.sourcePdfPage,
        item.assignedCollectionId,
        item.assignedPageNumber,
        item.assignedRecipeId,
        item.kind === 'TOC' ? 1 : 0,
        item.kind,
        item.status,
        item.claimExpiresAt ?? 0,
        item.attempts,
        item.lastError,
        item.parsedDrafts.length > 0 ? JSON.stringify(item.parsedDrafts) : null,
        item.modelUsed,
        item.promptTokens,
        item.completionTokens,
        item.costUsdMicros,
        JSON.stringify(item.createdRecipeIds),
        0,
        JSON.stringify(item.extraStoragePaths ?? []),
        item.updatedAt,
      ],
    );
  }
}

/**
 * Locate the user's active Speed Importer session for a given cookbook,
 * if any. A session is the most recently-updated planner batch (status
 * OPEN, deleted=0) that still has at least one item in AWAITING_GROUPING
 * — i.e. the user has captured something but not yet hit "Start OCR".
 *
 * Returning `undefined` is the "no session yet, create one on first
 * shutter" signal for SpeedImporterPage.
 */
export async function findOpenPlannerSession(
  ownerId: string,
  collectionId: string,
): Promise<ImportBatch | undefined> {
  const db = await getLocalDb();
  const rows = (await db.execO<ImportBatchSqlRow>(
    `select b.*
       from import_batches b
      where b.owner_id = ?
        and b.target_collection_id = ?
        and b.is_planner = 1
        and b.status = 'OPEN'
        and b.deleted = 0
        and exists (
          select 1 from import_items i
           where i.batch_id = b.id
             and i.status = 'AWAITING_GROUPING'
             and i.deleted = 0
        )
      order by b.updated_at desc
      limit 1`,
    [ownerId, collectionId],
  )) as ImportBatchSqlRow[];
  const row = rows[0];
  return row ? rowToBatch(row) : undefined;
}

/**
 * One-shot batch insert for the planner's lazy "create on first
 * shutter" path. Mirrors the inline insert in uploadBatch.ts but lets
 * the planner own the row up front so it can stash the batch id before
 * any storage upload happens.
 */
export async function insertLocalPlannerBatch(batch: ImportBatch): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into import_batches
       (id, owner_id, name, batch_kind, source_kind, target_collection_id,
        default_model, default_provider, fallback_model, fallback_provider,
        recitation_policy, status, total_items, is_planner, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [
      batch.id,
      batch.ownerId,
      batch.name,
      batch.batchKind,
      batch.sourceKind,
      batch.targetCollectionId,
      batch.defaultModel,
      batch.defaultProvider,
      batch.fallbackModel,
      batch.fallbackProvider,
      batch.recitationPolicy,
      batch.status,
      batch.totalItems,
      batch.isPlanner ? 1 : 0,
      batch.updatedAt,
    ],
  );
  await enqueue({ kind: 'import_batch_insert', entity_id: batch.id });
}

/**
 * Insert a planner-minted import_items row representing one captured
 * shot. Mirrors the inline insert in uploadBatch.ts but accepts the
 * pre-binding fields (assignedRecipeId / Collection / PageNumber) that
 * the planner sets at capture time, and unconditionally lands in
 * AWAITING_GROUPING so the worker doesn't claim the row before the
 * user has confirmed the session.
 */
export async function insertLocalPlannerItem(item: ImportItem): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into import_items
       (id, batch_id, owner_id, page_index, storage_path, thumb_path,
        source_pdf_path, source_pdf_page,
        assigned_collection_id, assigned_page_number, assigned_recipe_id,
        is_toc, kind, status, claim_expires_at, attempts, last_error,
        parsed_drafts_json, model_used, prompt_tokens, completion_tokens,
        cost_usd_micros, created_recipe_ids, needs_fallback,
        extra_storage_paths, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [
      item.id,
      item.batchId,
      item.ownerId,
      item.pageIndex,
      item.storagePath,
      item.thumbPath,
      item.sourcePdfPath,
      item.sourcePdfPage,
      item.assignedCollectionId,
      item.assignedPageNumber,
      item.assignedRecipeId,
      item.kind === 'TOC' ? 1 : 0,
      item.kind,
      item.status,
      item.claimExpiresAt ?? 0,
      item.attempts,
      item.lastError,
      null,
      null,
      0,
      0,
      0,
      JSON.stringify(item.createdRecipeIds ?? []),
      0,
      JSON.stringify(item.extraStoragePaths ?? []),
      item.updatedAt,
    ],
  );
  await enqueue({ kind: 'import_item_insert', entity_id: item.id });
}

/** Insert a batch row locally — used by the new-batch wizard before
 *  the server-side row arrives via realtime. Also enqueues a push so
 *  the user-editable fields (name, target collection) reach the server.
 */
export async function insertLocalBatch(batch: ImportBatch): Promise<void> {
  const db = await getLocalDb();
  await db.exec(
    `insert into import_batches
       (id, owner_id, name, source_kind, target_collection_id,
        default_model, default_provider, fallback_model, fallback_provider,
        recitation_policy, status, total_items, is_planner, updated_at, deleted)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [
      batch.id,
      batch.ownerId,
      batch.name,
      batch.sourceKind,
      batch.targetCollectionId,
      batch.defaultModel,
      batch.defaultProvider,
      batch.fallbackModel,
      batch.fallbackProvider,
      batch.recitationPolicy,
      batch.status,
      batch.totalItems,
      batch.isPlanner ? 1 : 0,
      batch.updatedAt,
    ],
  );
}
