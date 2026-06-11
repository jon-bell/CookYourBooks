import type { CookbooksClient } from './repositories.js';

export async function forkCollection(
  client: CookbooksClient,
  sourceCollectionId: string,
): Promise<string> {
  const { data, error } = await client.rpc('fork_collection', {
    source_collection_id: sourceCollectionId,
  });
  if (error) throw error;
  if (!data) throw new Error('fork_collection did not return an id');
  return data;
}

export interface PublicCollectionSummary {
  id: string;
  title: string;
  source_type: string;
  author: string | null;
  cover_image_path: string | null;
  owner_name: string | null;
  recipe_count: number;
}

export async function listPublicCollections(
  client: CookbooksClient,
  opts: { search?: string; sourceType?: string; limit?: number; offset?: number } = {},
): Promise<PublicCollectionSummary[]> {
  let query = client.from('public_collections').select('*');
  if (opts.sourceType) query = query.eq('source_type', opts.sourceType);
  if (opts.search) query = query.ilike('title', `%${opts.search}%`);
  query = query
    .order('title', { ascending: true })
    .range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50) - 1);
  const { data, error } = await query;
  if (error) throw error;
  return (data as PublicCollectionSummary[] | null) ?? [];
}

/**
 * Bulk-fetch recipe titles for a set of public collection ids. RLS on
 * `recipes` already allows anon to read rows whose parent collection
 * has `is_public = true`, so this works for signed-out visitors as
 * well. Used by the Discover page to expand multiple cards without
 * N+1 round-trips.
 */
export async function listPublicCollectionRecipeTitles(
  client: CookbooksClient,
  collectionIds: readonly string[],
): Promise<Map<string, { id: string; title: string; sort_order: number }[]>> {
  const out = new Map<string, { id: string; title: string; sort_order: number }[]>();
  if (collectionIds.length === 0) return out;
  // Chunk the IN list so a Discover page with many cards can't overflow the
  // PostgREST/Kong URL cap (UUIDs run ~36 chars each).
  const CHUNK = 200;
  for (let i = 0; i < collectionIds.length; i += CHUNK) {
    const slice = collectionIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from('recipes')
      .select('id, title, sort_order, collection_id')
      .in('collection_id', slice)
      .order('collection_id', { ascending: true })
      .order('sort_order', { ascending: true });
    if (error) throw error;
    for (const row of (data ?? []) as {
      id: string;
      title: string;
      sort_order: number;
      collection_id: string;
    }[]) {
      const arr = out.get(row.collection_id) ?? [];
      arr.push({ id: row.id, title: row.title, sort_order: row.sort_order });
      out.set(row.collection_id, arr);
    }
  }
  return out;
}
