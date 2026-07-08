import {
  buildTitleIndex,
  type LinkSource,
  type Recipe,
  resolveIngredientLink,
} from '@cookyourbooks/domain';
import type { StoredIngredient } from '@cookyourbooks/db';

import { getLocalDb } from './db.js';

interface TitleRow {
  id: string;
  title: string;
  has_content: number;
}

/**
 * Backfill pass: fill same-collection cross-reference links for one recipe's
 * currently-UNLINKED, auto-managed ingredients (see `@cookyourbooks/domain`
 * `resolveIngredientLink`) and persist them into the recipe's folded
 * `recipes.ingredients` JSON. Returns true if any link changed.
 *
 * Eligibility is deliberately "fill only" — `manual`/`dismissed` entries (user
 * intent) and entries that already carry a link are left untouched — so a
 * background pass on a device with an incomplete mirror can never clear a link
 * another device set (no cross-device fight). Re-running still links
 * sub-recipes added since (they surface as newly-matchable unlinked entries).
 * Save-time forward-linking is handled instead by {@link applyLinksToRecipe},
 * which runs before the push so the link isn't lost to a pull.
 *
 * Rewrites the `ingredients` JSON on the CRR `recipes` row. The CALLER must
 * enqueue a `recipe_save` so the change reaches Postgres via `save_recipes_graph`.
 */
export async function computeAndApplyLinks(
  recipeId: string,
  recipeTitle: string,
  collectionId: string,
): Promise<boolean> {
  const db = await getLocalDb();
  const rows = await db.execO<{ ingredients: string | null }>(
    `select ingredients from recipes where id = ?`,
    [recipeId],
  );
  const raw = rows[0]?.ingredients;
  if (!raw) return false;
  let ings: StoredIngredient[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    ings = parsed as StoredIngredient[];
  } catch {
    return false;
  }

  const hasEligible = ings.some(
    (i) => i.linkedRecipeId == null && i.linkSource !== 'manual' && i.linkSource !== 'dismissed',
  );
  if (!hasEligible) return false;

  // Index the host recipe's OWN collection only — same-collection is enforced
  // structurally, so an auto-link can never cross books. Placeholder targets
  // (has_content = 0) are valid; they fill in when OCR'd.
  const titleRows = await db.execO<TitleRow>(
    `select id, title, has_content from recipes where collection_id = ? and deleted = 0`,
    [collectionId],
  );
  const index = buildTitleIndex(
    titleRows.map((r) => ({ recipeId: r.id, title: r.title, hasContent: r.has_content === 1 })),
  );

  let changed = false;
  const next = ings.map((ing) => {
    if (
      ing.linkedRecipeId != null ||
      ing.linkSource === 'manual' ||
      ing.linkSource === 'dismissed'
    ) {
      return ing;
    }
    const match = resolveIngredientLink(ing.name, recipeId, recipeTitle, index);
    if (!match) return ing;
    changed = true;
    return { ...ing, linkedRecipeId: match.recipeId, linkSource: 'auto' as const };
  });
  if (!changed) return false;
  await db.exec(`update recipes set ingredients = ? where id = ?`, [
    JSON.stringify(next),
    recipeId,
  ]);
  return true;
}

/**
 * Resolve same-collection cross-reference links for a recipe's ingredients and
 * return a recipe with them applied (reads the collection's titles; writes
 * NOTHING). Called from the save path BEFORE the recipe is persisted/pushed, so
 * the link rides the recipe's very first `save_recipes_graph` push. This is the
 * key to correctness: a fire-and-forget pass after the save would push a
 * linkless recipe first, and a pull re-fetching that just-bumped recipe would
 * wholesale-replace its ingredient rows and wipe the link before the follow-up
 * push drained. `manual`/`dismissed` ingredients are preserved untouched.
 */
export async function applyLinksToRecipe(recipe: Recipe, collectionId: string): Promise<Recipe> {
  // Nothing auto-managed to (re)link? Skip the collection-titles query.
  if (!recipe.ingredients.some((i) => i.linkSource == null || i.linkSource === 'auto')) {
    return recipe;
  }

  const db = await getLocalDb();
  const titleRows = await db.execO<TitleRow>(
    `select id, title, has_content from recipes where collection_id = ? and deleted = 0`,
    [collectionId],
  );
  const index = buildTitleIndex(
    titleRows.map((r) => ({ recipeId: r.id, title: r.title, hasContent: r.has_content === 1 })),
  );

  let changed = false;
  const ingredients = recipe.ingredients.map((ing) => {
    if (ing.linkSource === 'manual' || ing.linkSource === 'dismissed') return ing;
    const match = resolveIngredientLink(ing.name, recipe.id, recipe.title, index);
    const nextLinked = match?.recipeId;
    const nextSource: LinkSource | undefined = match ? 'auto' : undefined;
    if (
      (ing.linkedRecipeId ?? undefined) === nextLinked &&
      (ing.linkSource ?? undefined) === nextSource
    ) {
      return ing;
    }
    changed = true;
    return { ...ing, linkedRecipeId: nextLinked, linkSource: nextSource };
  });
  return changed ? { ...recipe, ingredients } : recipe;
}
