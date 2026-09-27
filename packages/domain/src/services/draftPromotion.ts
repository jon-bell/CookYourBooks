// Draft → recipe promotion for OCR / link / PDF imports. Pure, so both the
// web app (interactive review + the batch auto-accept pass) and the CLI's
// `cyb demo load` promote drafts identically.

import { type Ingredient, isMeasured, measured, vague } from '../model/ingredient.js';
import { type Instruction, instruction } from '../model/instruction.js';
import { createRecipe, type Recipe } from '../model/recipe.js';
import type { ParsedRecipeDraft } from './parseRecipeText.js';

/**
 * Clone a draft's ingredients + instructions with fresh ids and remap
 * step→ingredient refs through the id map. Without this, promoting a
 * draft to a real recipe collides on the global UNIQUE(ingredients.id)
 * any time the user retries a save, or two drafts shared an id.
 *
 * Shared by the OCR import-item save path and the video-link import flow.
 */
export function withFreshIds(draft: ParsedRecipeDraft): {
  ingredients: Ingredient[];
  instructions: Instruction[];
} {
  const idMap = new Map<string, string>();
  const ingredients: Ingredient[] = draft.ingredients.map((ing) => {
    const newId = crypto.randomUUID();
    idMap.set(ing.id, newId);
    if (isMeasured(ing)) {
      return measured({
        id: newId,
        name: ing.name,
        preparation: ing.preparation,
        notes: ing.notes,
        quantity: ing.quantity,
      });
    }
    return vague({
      id: newId,
      name: ing.name,
      preparation: ing.preparation,
      notes: ing.notes,
      description: ing.description,
    });
  });
  const instructions: Instruction[] = draft.instructions.map((step, i) =>
    instruction({
      id: crypto.randomUUID(),
      stepNumber: i + 1,
      text: step.text,
      ingredientRefs: step.ingredientRefs
        .map((ref) => {
          const nextId = idMap.get(ref.ingredientId);
          if (!nextId) return undefined;
          return { ingredientId: nextId, quantity: ref.quantity };
        })
        .filter(
          (
            r,
          ): r is {
            ingredientId: string;
            quantity: (typeof step.ingredientRefs)[number]['quantity'];
          } => r !== undefined,
        ),
      temperature: step.temperature,
      subInstructions: step.subInstructions,
      notes: step.notes,
    }),
  );
  return { ingredients, instructions };
}

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
  /** Origin link for link/PDF imports; cookbook scans have none. */
  sourceUrl?: string;
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
    sourceUrl: ctx.sourceUrl,
    // New imports are never favorites; a fresh scan starts unmarked.
    starred: false,
  });
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
