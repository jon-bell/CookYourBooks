import type { Recipe } from '../model/recipe.js';
import type { RecipeCollection } from '../model/collection.js';

export function searchRecipes(recipes: readonly Recipe[], query: string): Recipe[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...recipes];
  return recipes.filter((r) => recipeMatches(r, q));
}

export function searchLibrary(
  collections: readonly RecipeCollection[],
  query: string,
): { collection: RecipeCollection; recipe: Recipe }[] {
  const q = query.trim().toLowerCase();
  const hits: { collection: RecipeCollection; recipe: Recipe }[] = [];
  for (const c of collections) {
    for (const r of c.recipes) {
      if (!q || recipeMatches(r, q)) hits.push({ collection: c, recipe: r });
    }
  }
  return hits;
}

function recipeMatches(recipe: Recipe, q: string): boolean {
  if (recipe.title.toLowerCase().includes(q)) return true;
  for (const ing of recipe.ingredients) {
    if (ing.name.toLowerCase().includes(q)) return true;
  }
  return false;
}
