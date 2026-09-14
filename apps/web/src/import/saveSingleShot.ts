import type { ParsedRecipeDraft } from '@cookyourbooks/domain';
import type { QueryClient } from '@tanstack/react-query';

import { collectionRepo, recipeRepo } from '../data/repos.js';
import { buildRecipeFromDraft } from './promoteDraft.js';

/**
 * Save a draft from a one-shot importer (a link or a PDF) as a finished
 * recipe, and say where it landed.
 *
 * The link and PDF pages had line-for-line copies of this, each also
 * reimplementing a thinner `buildRecipeFromDraft` that quietly dropped
 * bookTitle/pageNumbers. One copy, one behaviour.
 *
 * Lives apart from `promoteDraft.ts` so that module stays free of repo/Supabase
 * imports and its unit tests keep running without env.
 */
export interface SaveSingleShotInput {
  ownerId: string;
  draft: ParsedRecipeDraft;
  /** Display title for the per-source collection, e.g. "YouTube" or a host. */
  platformTitle: string;
  sourceUrl: string | null;
  /** Chosen destination; empty string = the per-source collection, on demand. */
  targetCollectionId: string;
  qc: QueryClient;
}

export async function saveSingleShotDraft({
  ownerId,
  draft,
  platformTitle,
  sourceUrl,
  targetCollectionId,
  qc,
}: SaveSingleShotInput): Promise<{ collectionId: string; recipeId: string }> {
  const recipe = buildRecipeFromDraft(draft, { sourceUrl: sourceUrl ?? undefined });
  const collections = collectionRepo(ownerId);
  // Re-attributed to an existing collection, or (default) the auto-detected
  // per-source website collection, created on demand so re-imports coalesce.
  const collectionId =
    targetCollectionId || (await collections.findOrCreateWebCollectionByPlatform(platformTitle));
  await recipeRepo(collectionId).save(recipe);
  qc.invalidateQueries({ queryKey: ['collections', ownerId] });
  qc.invalidateQueries({ queryKey: ['library-summaries', ownerId] });
  qc.invalidateQueries({ queryKey: ['collection', collectionId] });
  qc.invalidateQueries({ queryKey: ['collection-picker', ownerId] });
  return { collectionId, recipeId: recipe.id };
}
