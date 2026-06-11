import type { NutritionFact, NutritionSource } from '@cookyourbooks/domain';

import { supabase } from '../supabase.js';
import { readLocalFact, writeLocalFact, writeLocalFacts } from './localCache.js';

/**
 * Talks to the `nutrition` Edge Function for live USDA / Open Food Facts
 * lookups, and to the `nutrition_facts_cache` / `ingredient_nutrition_
 * mappings` tables directly for cache reads + override writes.
 *
 * The Edge Function path is auth-gated by JWT (any authenticated user)
 * so the platform's USDA key never reaches the browser bundle.
 */

const FUNCTION_PATH = '/functions/v1/nutrition';

async function callNutrition<T>(action: 'search' | 'get', body: unknown): Promise<T> {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('Sign in to look up nutrition data.');
  const url = `${import.meta.env.VITE_SUPABASE_URL}${FUNCTION_PATH}/${action}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (anonKey) headers.apikey = anonKey;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`nutrition ${action} ${resp.status}: ${text}`);
  }
  return (await resp.json()) as T;
}

export interface SearchResponse {
  hits: NutritionFact[];
}

/** Live search through the edge function. The function caches each hit
 *  into `nutrition_facts_cache` before returning. We mirror the same
 *  hits into the local SQLite cache so subsequent reads short-circuit
 *  the round-trip even before sync runs. */
export async function searchNutrition(
  q: string,
  limit = 10,
  opts: { includeBranded?: boolean } = {},
): Promise<NutritionFact[]> {
  if (!q.trim()) return [];
  const { hits } = await callNutrition<SearchResponse>('search', {
    q,
    limit,
    // Auto-match omits this (generic foods only); the manual override
    // dialog sets it so the user can pick a specific brand.
    include_branded: opts.includeBranded === true,
  });
  // Best-effort local mirror; never throw out a search result if the
  // local DB isn't ready (e.g. very first session before SyncProvider
  // has opened the file).
  try {
    await writeLocalFacts(hits);
  } catch (e) {
    console.warn('nutrition local cache write failed', e);
  }
  return hits;
}

/**
 * Local-first cache read. Returns the row if present locally, falling
 * back to the server's `nutrition_facts_cache` table (and mirroring the
 * server hit back into local). null on cache miss in both layers.
 *
 * Bypassing the local read with `forceRemote: true` is useful for the
 * admin UI when an admin has just edited a cache row server-side and
 * wants to see the change reflected immediately.
 */
export async function readCachedFact(
  source: NutritionSource,
  sourceId: string,
  opts: { forceRemote?: boolean } = {},
): Promise<NutritionFact | null> {
  if (!opts.forceRemote) {
    try {
      const local = await readLocalFact(source, sourceId);
      if (local) return local;
    } catch (e) {
      console.warn('nutrition local cache read failed', e);
    }
  }
  const { data, error } = await supabase
    .from('nutrition_facts_cache')
    .select('*')
    .eq('source', source)
    .eq('source_id', sourceId)
    .maybeSingle();
  if (error || !data) return null;
  // gen-types widens the jsonb `portions` to the broad `Json` union;
  // the edge function and the migration both guarantee the
  // `{ unit, grams }[]` shape, so cast through `unknown` to match
  // the domain interface.
  const fact = data as unknown as NutritionFact;
  try {
    await writeLocalFact(fact);
  } catch (e) {
    console.warn('nutrition local cache write failed', e);
  }
  return fact;
}

// ---------- Mapping resolution + writes ----------

export interface ResolvedMapping {
  source: NutritionSource;
  source_id: string;
  custom_grams_per_unit: Record<string, number>;
  origin: 'user' | 'platform';
}

/** Resolve the persisted mapping for an ingredient key, if any.
 *  Server-side function picks the user row first, falls back to the
 *  platform default. */
export async function resolveMapping(ingredientKey: string): Promise<ResolvedMapping | null> {
  const { data, error } = await supabase.rpc('resolve_nutrition_mapping', {
    p_ingredient_key: ingredientKey,
  });
  if (error) throw error;
  const rows = (data as ResolvedMapping[] | null) ?? [];
  return rows[0] ?? null;
}

/** Persist a user-scope mapping. Upserts on (owner_id, ingredient_key). */
export async function saveMapping(opts: {
  ingredientKey: string;
  source: NutritionSource;
  sourceId: string;
  customGramsPerUnit?: Record<string, number>;
}): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in to save a nutrition mapping.');
  const { error } = await supabase.from('ingredient_nutrition_mappings').upsert(
    {
      owner_id: user.id,
      ingredient_key: opts.ingredientKey,
      source: opts.source,
      source_id: opts.sourceId,
      custom_grams_per_unit: opts.customGramsPerUnit ?? {},
    },
    { onConflict: 'owner_id,ingredient_key' },
  );
  if (error) throw error;
}

/** Drop the user's mapping for an ingredient. Falls back to platform-
 *  default / auto-search on the next resolution. */
export async function deleteMapping(ingredientKey: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from('ingredient_nutrition_mappings')
    .delete()
    .eq('owner_id', user.id)
    .eq('ingredient_key', ingredientKey);
}
