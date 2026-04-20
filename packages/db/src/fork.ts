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
  return data as string;
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
