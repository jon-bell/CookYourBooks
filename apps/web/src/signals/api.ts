// Wire types + PostgREST calls for the interaction-signal write path.
//
// Both RPCs are security-definer and batched: the caller hands over an array,
// the server stamps owner_id from the JWT. See
// supabase/migrations/20260714000000_interaction_signals.sql.
//
// Snake_case field names here are the wire contract with the RPC's JSONB
// reader, not our usual camelCase domain shape — the SQL does `v_event->>'…'`
// with these exact keys.

import { supabase } from '../supabase.js';

/** A search that actually executed (kind='query') or a result the user then
 *  opened (kind='open'). The two are joined on `query_id`. */
export interface SearchEventPayload {
  query_id: string;
  kind: 'query' | 'open';
  query?: string;
  mode?: 'semantic' | 'substring';
  result_count?: number;
  truncated?: boolean;
  embedder_status?: 'idle' | 'loading' | 'ready' | 'unavailable';
  embedded_count?: number;
  source_filter?: string;
  opened_recipe_id?: string;
  opened_rank?: number;
  opened_score?: number;
}

/** What we proposed and what the human did about it. */
export interface SuggestionEventPayload {
  surface: 'nutrition_match' | 'tag';
  action: 'auto' | 'accepted' | 'corrected' | 'cleared';
  input_text?: string;
  /** What we ranked first — stable key, not display text. */
  suggested_key?: string;
  /** What the human took. Empty for 'cleared'. */
  chosen_key?: string;
  /** 0-based rank of `chosen_key` in `candidates`; omitted when off-list. */
  chosen_rank?: number;
  /** The ranked candidate keys we showed, so the row is a complete
   *  (input, candidates, chosen) training triple. */
  candidates?: string[];
}

// The two RPCs are created by 20260714000000 but aren't in the checked-in
// generated Supabase types yet (regenerated from the schema out of band, like
// every new RPC — same `as never` shim datausage/api.ts uses).

export async function postSearchEvents(events: readonly SearchEventPayload[]): Promise<void> {
  if (events.length === 0) return;
  const { error } = await supabase.rpc(
    'record_search_events' as never,
    {
      p_events: events,
    } as never,
  );
  if (error) throw error;
}

export async function postSuggestionEvents(
  events: readonly SuggestionEventPayload[],
): Promise<void> {
  if (events.length === 0) return;
  const { error } = await supabase.rpc(
    'record_suggestion_events' as never,
    {
      p_events: events,
    } as never,
  );
  if (error) throw error;
}
