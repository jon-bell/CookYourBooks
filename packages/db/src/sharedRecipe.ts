import type { Recipe } from '@cookyourbooks/domain';

import { rowToRecipe } from './mapping.js';
import type { CookbooksClient } from './repositories.js';

export interface SharedRecipeCollectionMeta {
  id: string;
  title: string;
  sourceType: string; // 'PUBLISHED_BOOK' | 'WEBSITE' | 'PERSONAL'
  author: string | null;
  siteName: string | null;
  isPublic: boolean;
}

export interface SharedRecipeResult {
  recipe: Recipe;
  /** null only if the collection row itself was RLS-filtered (defensive —
   *  the read branches mirror the recipe's, so this shouldn't happen). */
  collection: SharedRecipeCollectionMeta | null;
}

/**
 * Direct PostgREST fetch of one recipe graph by bare id, for the /r/:id
 * share view. RLS decides visibility — the owner, household co-members
 * (JWT claim), and anyone at all when the collection is public. Works with
 * an anon (signed-out) client. Returns null when the recipe is invisible
 * or nonexistent; the two are indistinguishable by design.
 */
export async function fetchSharedRecipe(
  client: CookbooksClient,
  recipeId: string,
): Promise<SharedRecipeResult | null> {
  const { data: recipeRow, error } = await client
    .from('recipes')
    .select('*')
    .eq('id', recipeId)
    .maybeSingle();
  if (error) throw error;
  if (!recipeRow) return null;

  // Children ride as JSON on the recipe row; only the collection meta is a
  // separate fetch now.
  const coll = await client
    .from('recipe_collections')
    .select('id, title, source_type, author, site_name, is_public')
    .eq('id', recipeRow.collection_id)
    .maybeSingle();
  if (coll.error) throw coll.error;

  return {
    recipe: rowToRecipe(recipeRow),
    collection: coll.data
      ? {
          id: coll.data.id,
          title: coll.data.title,
          sourceType: coll.data.source_type,
          author: coll.data.author,
          siteName: coll.data.site_name,
          isPublic: coll.data.is_public,
        }
      : null,
  };
}
