import type { Recipe } from '@cookyourbooks/domain';
import type { CookbooksClient } from './repositories.js';
import {
  rowsToRecipe,
  type IngredientRow,
  type InstructionRefRow,
  type InstructionRow,
  type RecipeRow,
} from './mapping.js';

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

  const [ings, inss, coll] = await Promise.all([
    client.from('ingredients').select('*').eq('recipe_id', recipeId),
    client.from('instructions').select('*').eq('recipe_id', recipeId),
    client
      .from('recipe_collections')
      .select('id, title, source_type, author, site_name, is_public')
      .eq('id', (recipeRow as RecipeRow).collection_id)
      .maybeSingle(),
  ]);
  if (ings.error) throw ings.error;
  if (inss.error) throw inss.error;
  if (coll.error) throw coll.error;

  const instructionRows = (inss.data ?? []) as InstructionRow[];
  let refRows: InstructionRefRow[] = [];
  if (instructionRows.length > 0) {
    const refs = await client
      .from('instruction_ingredient_refs')
      .select('*')
      .in(
        'instruction_id',
        instructionRows.map((i) => i.id),
      );
    if (refs.error) throw refs.error;
    refRows = (refs.data ?? []) as InstructionRefRow[];
  }

  return {
    recipe: rowsToRecipe(
      recipeRow as RecipeRow,
      (ings.data ?? []) as IngredientRow[],
      instructionRows,
      refRows,
    ),
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
