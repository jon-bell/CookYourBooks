// Activity feed data access. This is an ONLINE-only reporting surface — it
// reads the server-side `batch_jobs_report` view directly via PostgREST (RLS
// scopes rows to the caller + their household), exactly like the LLM Cost
// Center. It deliberately does NOT go through the local-first SQLite cache.

import { supabase } from '../supabase.js';

export type JobKind = 'ocr' | 'bakeoff' | 'rewrite' | 'remix' | 'embedding' | 'cover';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

/** One row of `public.batch_jobs_report` (one job; OCR aggregated per batch). */
export interface BatchJobRow {
  kind: JobKind;
  id: string;
  owner_id: string;
  household_id: string | null;
  requested_by: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  attempts: number | null;
  last_error: string | null;
  target_kind: 'recipe' | 'batch' | null;
  target_id: string | null;
  // OCR arm only (one row per batch); NULL for the per-job arms.
  pending_count: number | null;
  done_count: number | null;
  failed_count: number | null;
}

export interface JobsRange {
  from?: string; // ISO timestamp, inclusive (matched against updated_at)
  limit?: number;
}

/** Jobs the caller can see (own + household-shared), newest activity first. */
export async function listBatchJobs(opts: JobsRange = {}): Promise<BatchJobRow[]> {
  let q = supabase
    .from('batch_jobs_report')
    .select('*')
    // Embedding is a maintenance queue that re-enqueues on every recipe edit;
    // its completed rows are pure noise. Drop done embeddings at the source so
    // they don't eat the row budget — stuck/failed ones still surface.
    .or('kind.neq.embedding,status.neq.done')
    .order('updated_at', { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.from) q = q.gte('updated_at', opts.from);
  const { data, error } = await q;
  if (error) throw error;
  return (data as BatchJobRow[]) ?? [];
}

// Cancel/retry are only wired for the kinds with a meaningful owner action.
// OCR links out to /import (which has per-item reset); bake-off variants are
// seconds-long; embeddings self-heal on the next edit. The page hides the
// buttons for those, and for co-members' rows (the RPC would reject anyway).
type CancelRpc = 'rewrite_cancel' | 'remix_cancel' | 'cover_cancel';
type RetryRpc = 'rewrite_retry' | 'remix_retry' | 'cover_retry';

const CANCEL_RPC: Partial<Record<JobKind, CancelRpc>> = {
  rewrite: 'rewrite_cancel',
  remix: 'remix_cancel',
  cover: 'cover_cancel',
};
const RETRY_RPC: Partial<Record<JobKind, RetryRpc>> = {
  rewrite: 'rewrite_retry',
  remix: 'remix_retry',
  cover: 'cover_retry',
};

export function canCancel(kind: JobKind): boolean {
  return kind in CANCEL_RPC;
}
export function canRetry(kind: JobKind): boolean {
  return kind in RETRY_RPC;
}

/** Cancel a queued/running job. No-op for kinds without a cancel RPC. */
export async function cancelJob(kind: JobKind, id: string): Promise<void> {
  const rpc = CANCEL_RPC[kind];
  if (!rpc) return;
  const { error } = await supabase.rpc(rpc, { p_job_id: id });
  if (error) throw error;
}

/** Re-queue a failed job (server-side reset + best-effort worker kick). */
export async function retryJob(kind: JobKind, id: string): Promise<void> {
  const rpc = RETRY_RPC[kind];
  if (!rpc) return;
  const { error } = await supabase.rpc(rpc, { p_job_id: id });
  if (error) throw error;
}
