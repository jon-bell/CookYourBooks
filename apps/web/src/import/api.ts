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
