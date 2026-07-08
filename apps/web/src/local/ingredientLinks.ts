import {
  buildTitleIndex,
  type LinkSource,
  type Recipe,
  resolveIngredientLink,
} from '@cookyourbooks/domain';

import { getLocalDb } from './db.js';

interface IngRow {
  id: string;
  name: string;
  linked_recipe_id: string | null;
  link_source: string | null;
}

interface TitleRow {
  id: string;
  title: string;
  has_content: number;
}

/**
 * Backfill pass: fill same-collection cross-reference links for one recipe's
 * currently-UNLINKED, auto-managed ingredients (see `@cookyourbooks/domain`
 * `resolveIngredientLink`) and persist them into the local `ingredients` rows.
 * Returns true if any link changed.
 *
 * Eligibility is deliberately "fill only" — `manual`/`dismissed` rows (user
 * intent) and rows that already carry a link are left untouched — so a
 * background pass on a device with an incomplete mirror can never clear a link
 * another device set (no cross-device fight). Re-running still links
 * sub-recipes added since (they surface as newly-matchable unlinked rows).
 * Save-time forward-linking is handled instead by {@link applyLinksToRecipe},
 * which runs before the push so the link isn't lost to a pull.
 *
 * Writes the two columns directly on the CRR `ingredients` table (a targeted
 * update, like the `has_content` backfill). The CALLER must enqueue a
 * `recipe_save` so the change reaches Postgres via `save_recipes_graph`.
 */
export async function computeAndApplyLinks(
  recipeId: string,
  recipeTitle: string,
  collectionId: string,
): Promise<boolean> {
  const db = await getLocalDb();
  const ings = await db.execO<IngRow>(
    `select id, name, linked_recipe_id, link_source from ingredients where recipe_id = ?`,
    [recipeId],
  );

  const eligible = ings.filter(
    (i) =>
      i.linked_recipe_id == null && i.link_source !== 'manual' && i.link_source !== 'dismissed',
  );
  if (eligible.length === 0) return false;

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
  for (const ing of eligible) {
    const match = resolveIngredientLink(ing.name, recipeId, recipeTitle, index);
    const nextLinked = match?.recipeId ?? null;
    const nextSource: string | null = match ? 'auto' : null;
    const curLinked = ing.linked_recipe_id ?? null;
    const curSource = ing.link_source ?? null;
    if (nextLinked === curLinked && nextSource === curSource) continue;
    await db.exec(`update ingredients set linked_recipe_id = ?, link_source = ? where id = ?`, [
      nextLinked,
      nextSource,
      ing.id,
    ]);
    changed = true;
  }
  return changed;
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
