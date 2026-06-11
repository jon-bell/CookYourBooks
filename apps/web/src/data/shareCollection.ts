import { supabase } from '../supabase.js';

// Wrapper around the `global_toc_share_collection` RPC. Owner-only on
// the server (security definer + caller-id check). ISBN is optional;
// the RPC will refuse only if the ISBN collides with another source.

export async function shareCollectionToGlobal(collectionId: string): Promise<string> {
  const { data, error } = await supabase.rpc('global_toc_share_collection', {
    source_collection_id: collectionId,
  });
  if (error) throw error;
  return data;
}

// Returns the global_cookbooks row's id if this collection has been
// shared (i.e. has a row in global_cookbooks with matching
// shared_from_collection_id). Used to flip the button between "Share"
// and "Re-share (update)".
export async function findSharedGlobalEntry(
  collectionId: string,
): Promise<{ id: string; updated_at: string } | null> {
  const { data, error } = await supabase
    .from('global_cookbooks')
    .select('id, updated_at')
    .eq('shared_from_collection_id', collectionId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
