import type { Recipe } from './recipe.js';

export type SourceType = 'PUBLISHED_BOOK' | 'PERSONAL' | 'WEBSITE';

/** Set by the admin moderation flow on takedown; reset on republish. */
export type ModerationState = 'ACTIVE' | 'TAKEN_DOWN';

export interface CollectionBase {
  readonly id: string;
  readonly title: string;
  readonly sourceType: SourceType;
  readonly recipes: readonly Recipe[];
  readonly coverImagePath?: string;
  readonly isPublic: boolean;
  readonly forkedFrom?: string;
  readonly moderationState: ModerationState;
  readonly moderationReason?: string;
}

export interface Cookbook extends CollectionBase {
  readonly sourceType: 'PUBLISHED_BOOK';
  readonly author?: string;
  readonly isbn?: string;
  readonly publisher?: string;
  readonly publicationYear?: number;
}

export interface PersonalCollection extends CollectionBase {
  readonly sourceType: 'PERSONAL';
  readonly description?: string;
  readonly notes?: string;
}

export interface WebCollection extends CollectionBase {
  readonly sourceType: 'WEBSITE';
  readonly sourceUrl?: string;
  readonly dateAccessed?: string; // ISO date
  readonly siteName?: string;
}

export type RecipeCollection = Cookbook | PersonalCollection | WebCollection;

function newCollectionId(): string {
  return crypto.randomUUID();
}

type BaseParams = {
  id?: string;
  title: string;
  recipes?: readonly Recipe[];
  coverImagePath?: string;
  isPublic?: boolean;
  forkedFrom?: string;
  moderationState?: ModerationState;
  moderationReason?: string;
};

function commonFields(params: BaseParams) {
  return {
    id: params.id ?? newCollectionId(),
    title: params.title,
    recipes: [...(params.recipes ?? [])],
    coverImagePath: params.coverImagePath,
    isPublic: params.isPublic ?? false,
    forkedFrom: params.forkedFrom,
    moderationState: params.moderationState ?? ('ACTIVE' as ModerationState),
    moderationReason: params.moderationReason,
  };
}

export function createCookbook(
  params: BaseParams & {
    author?: string;
    isbn?: string;
    publisher?: string;
    publicationYear?: number;
  },
): Cookbook {
  return {
    sourceType: 'PUBLISHED_BOOK',
    ...commonFields(params),
    author: params.author,
    isbn: params.isbn,
    publisher: params.publisher,
    publicationYear: params.publicationYear,
  };
}

export function createPersonalCollection(
  params: BaseParams & { description?: string; notes?: string },
): PersonalCollection {
  return {
    sourceType: 'PERSONAL',
    ...commonFields(params),
    description: params.description,
    notes: params.notes,
  };
}

export function createWebCollection(
  params: BaseParams & { sourceUrl?: string; dateAccessed?: string; siteName?: string },
): WebCollection {
  return {
    sourceType: 'WEBSITE',
    ...commonFields(params),
    sourceUrl: params.sourceUrl,
    dateAccessed: params.dateAccessed,
    siteName: params.siteName,
  };
}

export function addRecipe(collection: RecipeCollection, recipe: Recipe): RecipeCollection {
  return { ...collection, recipes: [...collection.recipes, recipe] } as RecipeCollection;
}

export function removeRecipe(collection: RecipeCollection, recipeId: string): RecipeCollection {
  return {
    ...collection,
    recipes: collection.recipes.filter((r) => r.id !== recipeId),
  } as RecipeCollection;
}

export function updateRecipe(collection: RecipeCollection, recipe: Recipe): RecipeCollection {
  return {
    ...collection,
    recipes: collection.recipes.map((r) => (r.id === recipe.id ? recipe : r)),
  } as RecipeCollection;
}
