import type { RecipeCollection } from './model/collection.js';
import type { CollectionNote } from './model/collectionNote.js';
import type { CookingEvent, RecipeSnapshot } from './model/cookingEvent.js';
import type { Recipe } from './model/recipe.js';
import type { Tag } from './model/tag.js';

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

export interface CookingEventRepository {
  /** Past + upcoming events for one recipe (own + household-shared), newest first. */
  listForRecipe(recipeId: string): Promise<CookingEvent[]>;
  /** All events (own + household-shared) whose eventDate falls in [fromISO, toISO]. */
  listInDateRange(fromISO: string, toISO: string): Promise<CookingEvent[]>;
  get(id: string): Promise<CookingEvent | undefined>;
  save(event: CookingEvent): Promise<void>;
  /** Transition a PLANNED event to COOKED, capturing a recipe snapshot. */
  markCooked(id: string, snapshot: RecipeSnapshot): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface RecipeTagRepository {
  /** Tags on one recipe (own + household-shared). */
  listForRecipe(recipeId: string): Promise<Tag[]>;
  /** Distinct labels across the caller's (and shared) tags — the tag vocabulary. */
  listAllLabels(): Promise<string[]>;
  /** Recipe ids carrying the given label. */
  listRecipesByLabel(label: string): Promise<string[]>;
  /** Idempotent add keyed on the natural (recipe, label) pair. */
  addTag(recipeId: string, label: string): Promise<void>;
  removeTag(recipeId: string, label: string): Promise<void>;
}

export interface CollectionNoteRepository {
  /** Notes filed under one collection (own + household-shared), in sort order. */
  listForCollection(collectionId: string): Promise<CollectionNote[]>;
  save(note: CollectionNote): Promise<void>;
  delete(id: string): Promise<void>;
}
