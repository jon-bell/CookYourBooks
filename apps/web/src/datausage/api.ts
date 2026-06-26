// Data Usage data access. This is an ONLINE-only reporting surface — it reads
// the server-side `data_transfer_report` view + `data_transfer_summary` RPC
// directly via PostgREST (RLS scopes rows to the caller + their household),
// exactly like the LLM Cost Center and the household audit log. It deliberately
// does NOT go through the local-first SQLite cache.
//
// The WRITE path (`record_sync_transfer`) is owned by the sync engine, not this
// module — the reporting UI only reads.

import { supabase } from '../supabase.js';

export type TransferDirection = 'pull' | 'push';
export type TransferGroupBy = 'day' | 'direction' | 'phase';

export interface TransferRange {
  from?: string; // ISO timestamp, inclusive
  to?: string; // ISO timestamp, exclusive
}

/** One row of `public.data_transfer_report` (one sync-cycle phase). */
export interface TransferEventRow {
  id: string;
  owner_id: string;
  household_id: string | null;
  cycle_id: string;
  direction: TransferDirection;
  phase: string;
  rows: number;
  bytes: number;
  duration_ms: number;
  requests: number;
  created_at: string;
}

/** One bucket of the `data_transfer_summary` rollup RPC. */
export interface TransferSummaryRow {
  bucket: string | null;
  rows: number;
  bytes: number;
  requests: number;
  duration_ms: number;
  event_count: number;
}

// The `data_transfer_report` view + `data_transfer_summary` RPC are created by
// 20260704000000 but aren't in the checked-in generated Supabase types yet
// (those are regenerated from the schema out of band, like every new view/RPC).
// We pass the relation/fn names as `never` so this module compiles before the
// regen, while still returning fully-typed results at the boundary.

/** Per-event rows, newest first. RLS returns own + household-shared rows. */
export async function listTransferEvents(
  opts: TransferRange & { limit?: number } = {},
): Promise<TransferEventRow[]> {
  let q = supabase
    .from('data_transfer_report' as never)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.from) q = q.gte('created_at', opts.from);
  if (opts.to) q = q.lt('created_at', opts.to);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** Server-side rollup grouped by the chosen dimension. */
export async function getTransferSummary(
  opts: TransferRange & { groupBy: TransferGroupBy },
): Promise<TransferSummaryRow[]> {
  const { data, error } = await supabase.rpc(
    'data_transfer_summary' as never,
    {
      p_group_by: opts.groupBy,
      p_from: opts.from,
      p_to: opts.to,
    } as never,
  );
  if (error) throw error;
  return data ?? [];
}
