// Pure sort helpers for recipe lists. Kept free of component imports so unit
// tests (and any non-UI caller) can use them without dragging the supabase
// client (which throws at import time without VITE_ env) into the module
// graph via SortableRecipeList → CoverImage.
import type { CollectionRecipeSummary } from '../local/repositories.js';

/** How the cookbook list is ordered. `manual` is the user's drag order
 *  (persisted via sort_order); `name`/`page`/`made` are read-only views. */
export type RecipeSortMode = 'manual' | 'name' | 'page' | 'made';

export function isRecipeSortMode(v: string): v is RecipeSortMode {
  return v === 'manual' || v === 'name' || v === 'page' || v === 'made';
}

/**
 * Order items by most-recently-made first (per the `lastMade` map of
 * recipeId → 'YYYY-MM-DD'); never-made items sort last, ties break by title.
 * Generic over anything with id+title so the gallery page can reuse it.
 */
export function sortByLastMade<T extends { id: string; title: string }>(
  items: readonly T[],
  lastMade: ReadonlyMap<string, string> | undefined,
): T[] {
  return [...items].sort((a, b) => {
    const da = lastMade?.get(a.id) ?? '';
    const db = lastMade?.get(b.id) ?? '';
    if (da !== db) return da < db ? 1 : -1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
}

/** Smallest page number on a recipe, or +Infinity if it has none (so
 *  page-less entries sort last). */
export function minPage(recipe: CollectionRecipeSummary): number {
  const ps = (recipe.pageNumbers ?? []).filter((n) => Number.isFinite(n));
  return ps.length ? Math.min(...ps) : Number.POSITIVE_INFINITY;
}

export function sortRecipes(
  recipes: readonly CollectionRecipeSummary[],
  mode: RecipeSortMode,
  lastMade?: ReadonlyMap<string, string>,
): CollectionRecipeSummary[] {
  if (mode === 'made') return sortByLastMade(recipes, lastMade);
  const arr = [...recipes];
  if (mode === 'name') {
    arr.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  } else if (mode === 'page') {
    arr.sort((a, b) => {
      const d = minPage(a) - minPage(b);
      return d !== 0 ? d : a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });
  }
  return arr;
}
