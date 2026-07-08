import {
  createRecipe,
  type ParsedRecipeDraft,
  type Recipe,
  type RecipeCollection,
} from '@cookyourbooks/domain';

import { withFreshIds } from './draftToRecipe.js';
import type { ImportItem } from './model.js';
import { scoreTocMatch } from './tocMatch.js';

/**
 * Shared "draft → real recipe" logic for the bulk OCR flow. Both the
 * interactive review path (ImportItemPage.saveAsRecipe) and the batch
 * auto-accept pass (ImportBatchPage) build the recipe the same way, so it
 * lives here.
 */

export interface PromoteContext {
  /** Title of the target cookbook; becomes the recipe's bookTitle (an
   *  OCR-extracted bookTitle is only a hint and loses to the chosen book). */
  collectionTitle?: string;
  /** Existing recipe id to overwrite in place — a planner binding or a
   *  fuzzy title match against a placeholder. Undefined mints a fresh id. */
  recipeId?: string;
  /** Existing recipe title, used only when the draft itself has no title. */
  overwriteTitle?: string;
  /** Explicit page numbers (e.g. user-typed); falls back to the draft's. */
  pageNumbers?: number[];
  /**
   * Lineage link for derived recipes (e.g. Recipe Remix). Sets the new
   * recipe's parentRecipeId so the UI can render "based on …" / list
   * adaptations. Undefined for plain imports.
   */
  parentRecipeId?: string;
}

/**
 * Build a `Recipe` from an OCR draft. Re-mints ingredient/instruction ids
 * (see `withFreshIds`) so a retry — or two drafts that happened to share an
 * id — never trips the global UNIQUE on ingredients.id / instructions.id.
 */
export function buildRecipeFromDraft(draft: ParsedRecipeDraft, ctx: PromoteContext = {}): Recipe {
  const { ingredients, instructions } = withFreshIds(draft);
  const pageNumbers = ctx.pageNumbers ?? (draft.pageNumbers ? [...draft.pageNumbers] : undefined);
  return createRecipe({
    id: ctx.recipeId,
    title: draft.title?.trim() || ctx.overwriteTitle || 'Untitled',
    servings: draft.servings,
    ingredients,
    instructions,
    parentRecipeId: ctx.parentRecipeId,
    description: draft.description,
    timeEstimate: draft.timeEstimate,
    equipment: draft.equipment,
    bookTitle: ctx.collectionTitle ?? draft.bookTitle,
    pageNumbers,
    sourceImageText: draft.sourceImageText,
    // Filling a placeholder clears its planner star — the wish is granted.
    starred: false,
  });
}

/**
 * Resolve whether this draft should overwrite an existing recipe rather
 * than create a new one. Mirrors ImportItemPage's plannedRecipe +
 * matchedExisting precedence:
 *   1. Planner pre-binding (`item.assignedRecipeId`) always wins.
 *   2. Otherwise a tight (0.85) fuzzy title match against the target
 *      cookbook folds OCR-cleanup variants ("Garam Masala" vs "garam
 *      masala") into the placeholder instead of duplicating it.
 */
export function resolveTargetRecipe(
  draft: ParsedRecipeDraft,
  item: Pick<ImportItem, 'assignedRecipeId'>,
  collection: RecipeCollection | undefined,
): { recipeId?: string; overwriteTitle?: string } {
  if (!collection) return {};
  const recipes = collection.recipes ?? [];
  if (item.assignedRecipeId) {
    const r = recipes.find((rr) => rr.id === item.assignedRecipeId);
    if (r) return { recipeId: r.id, overwriteTitle: r.title };
  }
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
 * Per-draft auto-accept bar. A single OCR draft is auto-acceptable when it's
 * unambiguous enough that a human glance would rubber-stamp it: a real title,
 * a plausible ingredient and step count, and nothing the parser couldn't
 * place. Evaluated per *draft* rather than per page, so a page holding several
 * clean recipes — a sauces/dressings section, a two-up spread — promotes each
 * one and leaves only the weak siblings behind for review.
 */
export const AUTO_ACCEPT_MIN_INGREDIENTS = 3;
// One clear "combine everything" step is a complete recipe (market bowls,
// simple dressings/sauces), so the floor is a single instruction — the title,
// ingredient-count, and empty-leftover guards still keep bare fragments out.
export const AUTO_ACCEPT_MIN_INSTRUCTIONS = 1;

export function isDraftAutoAcceptable(draft: ParsedRecipeDraft): boolean {
  // The model flagged this as a page fragment (continues off-page / partial) —
  // hold it for review. `undefined` (older OCR, or a prompt that doesn't report
  // completeness) is treated as no signal, so structure alone decides.
  if (draft.complete === false) return false;
  if (!draft.title || !draft.title.trim()) return false;
  if (draft.ingredients.length < AUTO_ACCEPT_MIN_INGREDIENTS) return false;
  if (draft.instructions.length < AUTO_ACCEPT_MIN_INSTRUCTIONS) return false;
  if (draft.leftover.length !== 0) return false;
  return true;
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
