// LLM Cost Center data access. This is an ONLINE-only reporting surface — it
// reads the server-side `llm_usage_report` view + `llm_usage_summary` RPC
// directly via PostgREST (RLS scopes rows to the caller + their household),
// exactly like the household audit log. It deliberately does NOT go through
// the local-first SQLite cache.

import { supabase } from '../supabase.js';

export type LlmFeature = 'ocr' | 'bakeoff' | 'rewrite' | 'isbn' | 'video' | 'cover_image';
export type UsageGroupBy = 'model' | 'provider' | 'member' | 'feature' | 'day';

export interface UsageRange {
  from?: string; // ISO timestamp, inclusive
  to?: string; // ISO timestamp, exclusive
}

/** One row of `public.llm_usage_report` (one LLM query). */
export interface LlmUsageRow {
  id: string;
  feature: LlmFeature;
  owner_id: string;
  household_id: string | null;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_micros: number;
  latency_ms: number;
  error_kind: string | null;
  succeeded: boolean;
  key_owner_id: string | null;
  key_fingerprint: string | null;
  produced_ref: string | null;
  produced_kind: string | null;
  created_at: string;
}

/** One bucket of the `llm_usage_summary` rollup RPC. */
export interface LlmUsageSummaryRow {
  bucket: string | null;
  member_id: string | null;
  queries: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_micros: number;
  failures: number;
  avg_latency_ms: number | null;
}

/** Per-query rows, newest first. RLS returns own + household-shared rows. */
export async function listLlmUsage(
  opts: UsageRange & { limit?: number } = {},
): Promise<LlmUsageRow[]> {
  let q = supabase
    .from('llm_usage_report')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.from) q = q.gte('created_at', opts.from);
  if (opts.to) q = q.lt('created_at', opts.to);
  const { data, error } = await q;
  if (error) throw error;
  return (data as LlmUsageRow[]) ?? [];
}

/** Server-side rollup grouped by the chosen dimension. */
export async function getLlmUsageSummary(
  opts: UsageRange & { groupBy: UsageGroupBy },
): Promise<LlmUsageSummaryRow[]> {
  const { data, error } = await supabase.rpc('llm_usage_summary', {
    p_from: opts.from,
    p_to: opts.to,
    p_group_by: opts.groupBy,
  });
  if (error) throw error;
  return (data as LlmUsageSummaryRow[]) ?? [];
}

/**
 * Resolve display names for a set of user ids (key owners / members). Mirrors
 * the name-hydration in household/api.ts — profiles.display_name is publicly
 * readable, and key owners are always the caller or their household co-members.
 */
export async function fetchDisplayNames(ids: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data } = await supabase.from('profiles').select('id, display_name').in('id', unique);
  return new Map(
    ((data as { id: string; display_name: string | null }[]) ?? []).map((p) => [
      p.id,
      p.display_name,
    ]),
  );
}
