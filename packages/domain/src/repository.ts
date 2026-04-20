import type { Recipe } from './model/recipe.js';
import type { RecipeCollection } from './model/collection.js';

export interface RecipeRepository {
  list(): Promise<Recipe[]>;
  get(id: string): Promise<Recipe | undefined>;
  save(recipe: Recipe): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface RecipeCollectionRepository {
  list(): Promise<RecipeCollection[]>;
  get(id: string): Promise<RecipeCollection | undefined>;
  save(collection: RecipeCollection): Promise<void>;
  delete(id: string): Promise<void>;
}
