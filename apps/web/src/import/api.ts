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

// ---------- bakeoff ----------

export interface BakeoffVariantInput {
  name: string;
  provider: OcrProvider;
  model: string;
  prompt: string;
  base_url?: string;
}

export interface BakeoffVariantRow {
  id: string;
  run_id: string;
  name: string;
  provider: OcrProvider;
  model: string;
  prompt: string;
  base_url: string | null;
  status: 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';
  drafts: unknown[] | null;
  raw_text: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd_micros: number | null;
  latency_ms: number | null;
  error_kind: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface BakeoffRunRow {
  id: string;
  image_storage_path: string | null;
  status: 'OPEN' | 'CLOSED';
  task_kind: 'OCR' | 'REWRITE';
  input_recipe_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function startBakeoff(
  imageStoragePath: string | null,
  variants: ReadonlyArray<BakeoffVariantInput>,
  opts: { taskKind?: 'OCR' | 'REWRITE'; inputRecipeId?: string | null } = {},
): Promise<string> {
  const { data, error } = await supabase.rpc('bakeoff_start', {
    // The OCR path requires a non-null string here; the REWRITE path
    // accepts any value (the body inserts null into the column for
    // REWRITE). Coerce null → '' so the type stays `string` without
    // having to reorder args around the required p_variants.
    p_image_storage_path: imageStoragePath ?? '',
    // PostgREST's typed Json parameter accepts arrays-of-objects fine at
    // runtime, but the generated type alias is too narrow for it.
    p_variants: variants as unknown as never,
    p_task_kind: opts.taskKind ?? 'OCR',
    p_input_recipe_id: opts.inputRecipeId ?? undefined,
  });
  if (error) throw error;
  return data as string;
}

export async function getBakeoffRun(runId: string): Promise<{
  run: BakeoffRunRow;
  variants: BakeoffVariantRow[];
}> {
  // No bespoke RPC: PostgREST + RLS already scopes both tables to the
  // owner, so two parallel reads are fine. Keeping this in one helper
  // means callers don't have to know about the realtime topic shape.
  const [runQ, vQ] = await Promise.all([
    supabase
      .from('bakeoff_runs')
      .select('id, image_storage_path, status, task_kind, input_recipe_id, created_at, updated_at')
      .eq('id', runId)
      .maybeSingle(),
    supabase
      .from('bakeoff_variants')
      .select(
        'id, run_id, name, provider, model, prompt, base_url, status, drafts, raw_text, prompt_tokens, completion_tokens, cost_usd_micros, latency_ms, error_kind, error_message, created_at, updated_at',
      )
      .eq('run_id', runId)
      .order('sort_index', { ascending: true }),
  ]);
  if (runQ.error) throw runQ.error;
  if (vQ.error) throw vQ.error;
  if (!runQ.data) throw new Error('Bakeoff run not found');
  return {
    run: runQ.data as BakeoffRunRow,
    variants: (vQ.data ?? []) as BakeoffVariantRow[],
  };
}

export async function promoteBakeoffVariant(variantId: string): Promise<void> {
  const { error } = await supabase.rpc('import_bakeoff_promote', { p_variant_id: variantId });
  if (error) {
    const legacy = await supabase.rpc('bakeoff_promote', { p_variant_id: variantId });
    if (legacy.error) throw legacy.error;
    return;
  }
}

export async function seedBakeoffBatch(
  batchId: string,
  variants: ReadonlyArray<BakeoffVariantInput>,
): Promise<void> {
  const { error } = await supabase.rpc('import_bakeoff_seed', {
    p_batch_id: batchId,
    p_variants: variants as unknown as never,
  });
  if (error) throw error;
}

export async function selectBakeoffWinner(itemId: string, variantId: string): Promise<void> {
  const { error } = await supabase.rpc('import_bakeoff_select_winner', {
    p_item_id: itemId,
    p_variant_id: variantId,
  });
  if (error) throw error;
}

export interface ImportBatchVariantRow {
  id: string;
  batch_id: string;
  sort_index: number;
  name: string;
  provider: OcrProvider;
  model: string;
  prompt: string;
  base_url: string | null;
}

export interface ImportItemVariantResultRow {
  id: string;
  item_id: string;
  variant_id: string;
  status: 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';
  drafts: unknown[] | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd_micros: number | null;
  latency_ms: number | null;
  error_kind: string | null;
  error_message: string | null;
}

export async function getBatchVariants(batchId: string): Promise<ImportBatchVariantRow[]> {
  const { data, error } = await supabase
    .from('import_batch_variants')
    .select('id, batch_id, sort_index, name, provider, model, prompt, base_url')
    .eq('batch_id', batchId)
    .order('sort_index', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ImportBatchVariantRow[];
}

export async function getItemVariantResults(
  itemId: string,
): Promise<ImportItemVariantResultRow[]> {
  const { data, error } = await supabase
    .from('import_item_variant_results')
    .select(
      'id, item_id, variant_id, status, drafts, prompt_tokens, completion_tokens, cost_usd_micros, latency_ms, error_kind, error_message',
    )
    .eq('item_id', itemId);
  if (error) throw error;
  return (data ?? []) as ImportItemVariantResultRow[];
}

// ---------- user OCR prefs (server-side) ----------

export interface UserOcrPrefs {
  provider: OcrProvider;
  model: string;
  prompt: string;
  updated_at: string;
}

export async function getUserOcrPrefs(): Promise<UserOcrPrefs | null> {
  const { data, error } = await supabase
    .from('user_ocr_prefs')
    .select('provider, model, prompt, updated_at')
    .maybeSingle();
  if (error) throw error;
  return (data as UserOcrPrefs | null) ?? null;
}

export async function setUserOcrPrefs(prefs: {
  provider: OcrProvider;
  model: string;
  prompt: string;
}): Promise<void> {
  const { error } = await supabase.rpc('user_ocr_prefs_set', {
    p_provider: prefs.provider,
    p_model: prefs.model,
    p_prompt: prefs.prompt,
  });
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
    // The function body normalises empty / null inputs to "clear"; the
    // generated type alias erroneously narrows these to required text.
    p_provider: provider as unknown as string,
    p_model: model as unknown as string,
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

// ---------- instruction rewrites ----------

export interface UserRewritePrefs {
  provider: OcrProvider;
  model: string;
  prompt: string;
  updated_at: string;
}

export async function getUserRewritePrefs(): Promise<UserRewritePrefs | null> {
  const { data, error } = await supabase
    .from('user_rewrite_prefs')
    .select('provider, model, prompt, updated_at')
    .maybeSingle();
  if (error) throw error;
  return (data as UserRewritePrefs | null) ?? null;
}

export async function setUserRewritePrefs(prefs: {
  provider: OcrProvider;
  model: string;
  prompt: string;
}): Promise<void> {
  const { error } = await supabase.rpc('user_rewrite_prefs_set', {
    p_provider: prefs.provider,
    p_model: prefs.model,
    p_prompt: prefs.prompt,
  });
  if (error) throw error;
}

export async function startRewrite(input: {
  recipeId: string;
  provider: OcrProvider;
  model: string;
  prompt: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('rewrite_start', {
    p_recipe_id: input.recipeId,
    p_provider: input.provider,
    p_model: input.model,
    p_prompt: input.prompt,
  });
  if (error) throw error;
  return data as string;
}

export async function cancelRewrite(jobId: string): Promise<void> {
  const { error } = await supabase.rpc('rewrite_cancel', { p_job_id: jobId });
  if (error) throw error;
}

export async function kickRewrite(recipeId?: string): Promise<void> {
  const { error } = await supabase.rpc('rewrite_kick', {
    p_recipe_id: recipeId ?? undefined,
  });
  if (error) {
    // Same error class as kickOcr — the underlying vault secret is shared,
    // so the configuration-missing case looks identical.
    if (error.message?.startsWith('OCR_WORKER_NOT_CONFIGURED')) {
      throw new OcrWorkerNotConfiguredError(error.message);
    }
    throw error;
  }
}
