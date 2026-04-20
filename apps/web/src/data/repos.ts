import type { Recipe, RecipeCollection } from '@cookyourbooks/domain';
import {
  LocalRecipeCollectionRepository,
  LocalRecipeRepository,
} from '../local/repositories.js';

export function collectionRepo(ownerId: string) {
  return new LocalRecipeCollectionRepository(ownerId);
}

export function recipeRepo(collectionId: string) {
  return new LocalRecipeRepository(collectionId);
}

export type { Recipe, RecipeCollection };
