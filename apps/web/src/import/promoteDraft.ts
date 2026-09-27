import {
  isDraftAutoAcceptable,
  type ParsedRecipeDraft,
  type RecipeCollection,
} from '@cookyourbooks/domain';

import type { ImportItem } from './model.js';
import { scoreTocMatch } from './tocMatch.js';

// The pure draft → recipe helpers (buildRecipeFromDraft, isDraftAutoAcceptable,
// the AUTO_ACCEPT_* bars) live in @cookyourbooks/domain so the CLI demo loader
// shares them; re-exported here for the existing import sites.
export {
  AUTO_ACCEPT_MIN_INGREDIENTS,
  AUTO_ACCEPT_MIN_INSTRUCTIONS,
  buildRecipeFromDraft,
  isDraftAutoAcceptable,
  type PromoteContext,
} from '@cookyourbooks/domain';

// Shared "draft → real recipe" logic for the bulk OCR flow. Both the
// interactive review path (ImportItemPage.saveAsRecipe) and the batch
// auto-accept pass (ImportBatchPage) build the recipe the same way, so it
// lives here.

/**
 * Resolve whether this draft should overwrite an existing recipe rather
 * than create a new one. Mirrors ImportItemPage's matchedExisting logic:
 * a tight (0.85) fuzzy title match against the target cookbook folds
 * OCR-cleanup variants ("Garam Masala" vs "garam masala") into the
 * placeholder instead of duplicating it.
 */
export function resolveTargetRecipe(
  draft: ParsedRecipeDraft,
  collection: RecipeCollection | undefined,
): { recipeId?: string; overwriteTitle?: string } {
  if (!collection) return {};
  const recipes = collection.recipes ?? [];
  const title = draft.title?.trim();
  if (!title) return {};
  let best: { id: string; title: string; score: number } | undefined;
  for (const r of recipes) {
    const score = scoreTocMatch(title, r.title);
    if (score >= 0.85 && (!best || score > best.score)) {
      best = { id: r.id, title: r.title, score };
    }
  }
  return best ? { recipeId: best.id, overwriteTitle: best.title } : {};
}

/**
 * Which drafts on an item should auto-promote. Empty when the item itself is
 * ineligible — not OCR_DONE, a TOC/NOTES page (those have their own paths), or
 * nowhere to file the recipe — otherwise the indices of the drafts that clear
 * the per-draft bar. The caller promotes those and leaves any remaining (weak)
 * drafts on the item for manual review.
 *
 * Bakeoff items are not special-cased here — they only reach OCR_DONE once a
 * winner is picked; callers gate the auto-run to STANDARD batches anyway.
 */
export function autoAcceptableDraftIndices(
  item: Pick<ImportItem, 'status' | 'kind' | 'parsedDrafts' | 'assignedCollectionId'>,
  batchTargetCollectionId: string | null,
): number[] {
  if (item.status !== 'OCR_DONE') return [];
  if (item.kind !== 'RECIPE') return [];
  if (!(item.assignedCollectionId ?? batchTargetCollectionId)) return [];
  const out: number[] = [];
  item.parsedDrafts.forEach((draft, i) => {
    if (isDraftAutoAcceptable(draft)) out.push(i);
  });
  return out;
}
