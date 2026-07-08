import {
  createCookbook,
  createPersonalCollection,
  createRecipe,
  createWebCollection,
  type Recipe,
  type RecipeCollection,
  servings as makeServings,
} from '@cookyourbooks/domain';

import type { Database } from './database.types.js';
import { deserializeChildren, serializeChildren } from './recipeJson.js';

type Tables = Database['public']['Tables'];
export type CollectionRow = Tables['recipe_collections']['Row'];
export type CollectionInsert = Tables['recipe_collections']['Insert'];
export type RecipeRow = Tables['recipes']['Row'];
export type RecipeInsert = Tables['recipes']['Insert'];
export type CookingEventRow = Tables['cooking_events']['Row'];
export type CookingEventInsert = Tables['cooking_events']['Insert'];
export type RecipeTagRow = Tables['recipe_tags']['Row'];
export type RecipeTagInsert = Tables['recipe_tags']['Insert'];
export type CollectionNoteRow = Tables['collection_notes']['Row'];
export type CollectionNoteInsert = Tables['collection_notes']['Insert'];

// ---- Collection ----

export function rowToCollection(row: CollectionRow, recipes: Recipe[] = []): RecipeCollection {
  const base = {
    id: row.id,
    title: row.title,
    recipes,
    coverImagePath: row.cover_image_path ?? undefined,
    isPublic: row.is_public,
    forkedFrom: row.forked_from ?? undefined,
    moderationState:
      (row as CollectionRow & { moderation_state?: string | null }).moderation_state ===
      'TAKEN_DOWN'
        ? ('TAKEN_DOWN' as const)
        : ('ACTIVE' as const),
    moderationReason:
      (row as CollectionRow & { moderation_reason?: string | null }).moderation_reason ?? undefined,
  };
  switch (row.source_type) {
    case 'PUBLISHED_BOOK':
      return createCookbook({
        ...base,
        author: row.author ?? undefined,
        isbn: row.isbn ?? undefined,
        publisher: row.publisher ?? undefined,
        publicationYear: row.publication_year ?? undefined,
      });
    case 'WEBSITE':
      return createWebCollection({
        ...base,
        sourceUrl: row.source_url ?? undefined,
        dateAccessed: row.date_accessed ?? undefined,
        siteName: row.site_name ?? undefined,
      });
    case 'PERSONAL':
    default:
      return createPersonalCollection({
        ...base,
        description: row.description ?? undefined,
        notes: row.notes ?? undefined,
      });
  }
}

export function collectionToInsert(c: RecipeCollection, ownerId: string): CollectionInsert {
  const base: CollectionInsert = {
    id: c.id,
    owner_id: ownerId,
    title: c.title,
    source_type: c.sourceType,
    is_public: c.isPublic,
    cover_image_path: c.coverImagePath ?? null,
    forked_from: c.forkedFrom ?? null,
  };
  switch (c.sourceType) {
    case 'PUBLISHED_BOOK':
      return {
        ...base,
        author: c.author ?? null,
        isbn: c.isbn ?? null,
        publisher: c.publisher ?? null,
        publication_year: c.publicationYear ?? null,
      };
    case 'WEBSITE':
      return {
        ...base,
        source_url: c.sourceUrl ?? null,
        date_accessed: c.dateAccessed ?? null,
        site_name: c.siteName ?? null,
      };
    case 'PERSONAL':
      return {
        ...base,
        description: c.description ?? null,
        notes: c.notes ?? null,
      };
  }
}

// ---- Recipe ----

// Accept either a native JS array (Postgres jsonb → parsed) or a JSON
// string (the local-SQLite mirror stores these as TEXT). `undefined`
// or malformed inputs produce `undefined` so callers can .. ?? default.
function jsonArray<T>(raw: unknown): T[] | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stringArray(raw: unknown): string[] | undefined {
  const arr = jsonArray<unknown>(raw);
  if (!arr) return undefined;
  const out = arr.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
}

function numberArray(raw: unknown): number[] | undefined {
  const arr = jsonArray<unknown>(raw);
  if (!arr) return undefined;
  const out = arr.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return out.length > 0 ? out : undefined;
}

function toBool(v: unknown): boolean {
  return v === true || v === 1;
}

/**
 * Build a domain Recipe from a recipe row. Children (`ingredients` /
 * `instructions`) ride as JSON on the row itself — a native array from
 * Postgres jsonb, or a JSON string from the local-SQLite mirror.
 * `deserializeChildren` tolerates both and degrades malformed entries.
 */
export function rowToRecipe(row: RecipeRow): Recipe {
  const rowX = row as RecipeRow & {
    servings_amount_max?: number | null;
    description?: string | null;
    time_estimate?: string | null;
    equipment?: unknown;
    book_title?: string | null;
    page_numbers?: unknown;
    source_image_text?: string | null;
    source_url?: string | null;
    starred?: boolean | number | null;
    cover_image_path?: string | null;
    ingredients?: unknown;
    instructions?: unknown;
  };
  const { ingredients, instructions } = deserializeChildren(rowX.ingredients, rowX.instructions);
  return createRecipe({
    id: row.id,
    title: row.title,
    servings:
      row.servings_amount != null && row.servings_amount > 0
        ? makeServings(
            row.servings_amount,
            row.servings_description ?? undefined,
            rowX.servings_amount_max != null && rowX.servings_amount_max >= row.servings_amount
              ? rowX.servings_amount_max
              : undefined,
          )
        : undefined,
    ingredients,
    instructions,
    notes: row.notes ?? undefined,
    parentRecipeId: row.parent_recipe_id ?? undefined,
    description: rowX.description ?? undefined,
    timeEstimate: rowX.time_estimate ?? undefined,
    equipment: stringArray(rowX.equipment),
    bookTitle: rowX.book_title ?? undefined,
    pageNumbers: numberArray(rowX.page_numbers),
    sourceImageText: rowX.source_image_text ?? undefined,
    sourceUrl: rowX.source_url ?? undefined,
    // Local SQLite stores starred as 0/1; Postgres returns a real
    // boolean. Either flavor is truthy when set.
    starred: toBool(rowX.starred),
    coverImagePath: rowX.cover_image_path ?? undefined,
  });
}

export function recipeToInsert(recipe: Recipe, collectionId: string, sortOrder = 0): RecipeInsert {
  const { ingredients, instructions } = serializeChildren(recipe);
  const base: RecipeInsert = {
    id: recipe.id,
    collection_id: collectionId,
    title: recipe.title,
    servings_amount: recipe.servings?.amount ?? null,
    servings_description: recipe.servings?.description ?? null,
    sort_order: sortOrder,
    notes: recipe.notes ?? null,
    parent_recipe_id: recipe.parentRecipeId ?? null,
  };
  const extras: Record<string, unknown> = {
    servings_amount_max: recipe.servings?.amountMax ?? null,
    description: recipe.description ?? null,
    time_estimate: recipe.timeEstimate ?? null,
    // Stored as `jsonb` in Postgres; the supabase-js client serializes
    // arrays automatically. The local-SQLite path stringifies in its
    // own upsert helper before binding.
    equipment: recipe.equipment ? [...recipe.equipment] : null,
    book_title: recipe.bookTitle ?? null,
    page_numbers: recipe.pageNumbers ? [...recipe.pageNumbers] : null,
    source_image_text: recipe.sourceImageText ?? null,
    source_url: recipe.sourceUrl ?? null,
    starred: recipe.starred === true,
    cover_image_path: recipe.coverImagePath ?? null,
    has_content: ingredients.length > 0 || instructions.length > 0,
    // Folded children — jsonb in Postgres, JSON text in local SQLite.
    ingredients,
    instructions,
  };
  return { ...base, ...extras };
}
