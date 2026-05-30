import { supabase } from '../supabase.js';
import type { NutritionFact, NutritionSource } from '@cookyourbooks/domain';

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
 *  into `nutrition_facts_cache` before returning, so subsequent calls
 *  via {@link readCached} are network-free. */
export async function searchNutrition(q: string, limit = 10): Promise<NutritionFact[]> {
  if (!q.trim()) return [];
  const { hits } = await callNutrition<SearchResponse>('search', { q, limit });
  return hits;
}

/** Cache read. Returns the row if present, null otherwise. Used when
 *  we've already resolved a mapping for the ingredient and just want
 *  the latest facts. */
export async function readCachedFact(
  source: NutritionSource,
  sourceId: string,
): Promise<NutritionFact | null> {
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
  return data as unknown as NutritionFact;
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
export async function resolveMapping(
  ingredientKey: string,
): Promise<ResolvedMapping | null> {
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
  const { data: { user } } = await supabase.auth.getUser();
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from('ingredient_nutrition_mappings')
    .delete()
    .eq('owner_id', user.id)
    .eq('ingredient_key', ingredientKey);
}
