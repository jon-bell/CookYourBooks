import { pushImportBatchGraph } from '../local/sync.js';
import { supabase } from '../supabase.js';

// Typed wrappers around the user-facing bulk OCR RPCs. Anything that
// runs as the service role (the worker's claim / complete / fail
// endpoints) lives in the Edge Function, not here.

export type OcrProvider = 'gemini' | 'openai-compatible';
export type RecitationPolicy = 'FALLBACK' | 'FAIL';

export interface OcrKeySummary {
  provider: string;
  key_fingerprint: string;
  base_url: string | null;
  rotated_at: string;
}

export async function setOcrKey(
  provider: OcrProvider,
  rawKey: string,
  baseUrl?: string,
): Promise<void> {
  const { error } = await supabase.rpc('ocr_key_set', {
    p_provider: provider,
    p_raw_key: rawKey,
    p_base_url: baseUrl ?? undefined,
  });
  if (error) throw error;
}

export async function deleteOcrKey(provider: OcrProvider): Promise<void> {
  const { error } = await supabase.rpc('ocr_key_delete', { p_provider: provider });
  if (error) throw error;
}

export async function resetImportItem(itemId: string): Promise<void> {
  const { error } = await supabase.rpc('import_reset_item', { p_item_id: itemId });
  if (error) throw error;
}

export async function mergeImportItems(
  primaryId: string,
  absorbIds: readonly string[],
): Promise<void> {
  const { error } = await supabase.rpc('import_merge_items', {
    p_primary_id: primaryId,
    p_absorb_ids: [...absorbIds],
  });
  if (error) throw error;
}

/**
 * Confirm a "Group then OCR" batch's groupings. `groups` is an array of
 * item-id arrays — within each inner array the first id is the primary
 * (recipe gets that page's storage_path) and the rest are absorbed
 * (DISCARDED, their storage_paths appended to the primary's extras).
 * Singletons are passed as one-element arrays. All AWAITING_GROUPING
 * primaries flip to PENDING in one transaction.
 */
export async function finalizeGrouping(
  batchId: string,
  groups: readonly (readonly string[])[],
): Promise<void> {
  // Batch metadata is local-first; the RPC runs on Postgres and needs
  // the row (and items) to exist server-side before it can authorize.
  await pushImportBatchGraph(supabase, batchId);
  const { error } = await supabase.rpc('import_finalize_grouping', {
    p_batch_id: batchId,
    p_groups: groups.map((g) => [...g]),
  });
  if (error) throw error;
}

export async function setRecitationPolicy(
  batchId: string,
  policy: RecitationPolicy,
): Promise<void> {
  const { error } = await supabase.rpc('import_set_recitation_policy', {
    p_batch_id: batchId,
    p_policy: policy,
  });
  if (error) throw error;
}

export async function setBatchFallback(
  batchId: string,
  provider: OcrProvider | null,
  model: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('import_set_batch_fallback', {
    p_batch_id: batchId,
    p_provider: provider,
    p_model: model,
  });
  if (error) throw error;
}

export async function retryRecitationFailures(batchId: string): Promise<number> {
  const { data, error } = await supabase.rpc('import_retry_recitation_failures', {
    p_batch_id: batchId,
  });
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}

export class OcrWorkerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrWorkerNotConfiguredError';
  }
}

export async function kickOcr(batchId?: string): Promise<void> {
  const { error } = await supabase.rpc('ocr_kick', {
    p_batch_id: batchId ?? undefined,
  });
  if (error) {
    if (error.message?.startsWith('OCR_WORKER_NOT_CONFIGURED')) {
      throw new OcrWorkerNotConfiguredError(error.message);
    }
    throw error;
  }
}

export async function listOcrKeys(): Promise<OcrKeySummary[]> {
  // RLS scopes this to the caller's rows. The `vault_secret_id` column
  // is column-revoked from the `authenticated` role, so we project the
  // safe-to-display fields explicitly rather than using `select('*')`.
  const { data, error } = await supabase
    .from('user_ocr_keys')
    .select('provider, key_fingerprint, base_url, rotated_at');
  if (error) throw error;
  return (data ?? []) as OcrKeySummary[];
}
