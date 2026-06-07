import type { Recipe, RecipeCollection } from '@cookyourbooks/domain';
import {
  LocalCookingEventRepository,
  LocalRecipeCollectionRepository,
  LocalRecipeRepository,
  LocalRecipeTagRepository,
  LocalRecipeViewRepository,
} from '../local/repositories.js';

export function collectionRepo(ownerId: string) {
  return new LocalRecipeCollectionRepository(ownerId);
}

export function recipeRepo(collectionId: string) {
  return new LocalRecipeRepository(collectionId);
}

export function cookingEventRepo(ownerId: string) {
  return new LocalCookingEventRepository(ownerId);
}

export function recipeTagRepo(ownerId: string) {
  return new LocalRecipeTagRepository(ownerId);
}

// View history is local-only and not owner-scoped (single device store).
export function recipeViewRepo() {
  return new LocalRecipeViewRepository();
}

export type { Recipe, RecipeCollection };
