import {
  createCookbook,
  createPersonalCollection,
  createWebCollection,
  createRecipe,
  instruction,
  measured,
  vague,
  exact,
  fractional,
  range,
  servings as makeServings,
  type Ingredient,
  type Instruction,
  type Quantity,
  type Recipe,
  type RecipeCollection,
} from '@cookyourbooks/domain';
import type { Database } from './database.types.js';

type Tables = Database['public']['Tables'];
export type CollectionRow = Tables['recipe_collections']['Row'];
export type CollectionInsert = Tables['recipe_collections']['Insert'];
export type RecipeRow = Tables['recipes']['Row'];
export type RecipeInsert = Tables['recipes']['Insert'];
export type IngredientRow = Tables['ingredients']['Row'];
export type IngredientInsert = Tables['ingredients']['Insert'];
export type InstructionRow = Tables['instructions']['Row'];
export type InstructionInsert = Tables['instructions']['Insert'];
export type InstructionRefRow = Tables['instruction_ingredient_refs']['Row'];
export type InstructionRefInsert = Tables['instruction_ingredient_refs']['Insert'];

// ---- Collection ----

export function rowToCollection(
  row: CollectionRow,
  recipes: Recipe[] = [],
): RecipeCollection {
  const base = {
    id: row.id,
    title: row.title,
    recipes,
    coverImagePath: row.cover_image_path ?? undefined,
    isPublic: row.is_public,
    forkedFrom: row.forked_from ?? undefined,
    moderationState:
      (row as CollectionRow & { moderation_state?: string | null }).moderation_state === 'TAKEN_DOWN'
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

export function rowsToRecipe(
  row: RecipeRow,
  ingredientRows: IngredientRow[],
  instructionRows: InstructionRow[],
  refRows: InstructionRefRow[] = [],
): Recipe {
  const ingredients = [...ingredientRows]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(rowToIngredient);
  // Index refs by instruction id so we can attach them without an
  // O(n·m) scan per step.
  const refsByInstruction = new Map<string, string[]>();
  for (const r of refRows) {
    const list = refsByInstruction.get(r.instruction_id) ?? [];
    list.push(r.ingredient_id);
    refsByInstruction.set(r.instruction_id, list);
  }
  const instructions = [...instructionRows]
    .sort((a, b) => a.step_number - b.step_number)
    .map((ins) => rowToInstruction(ins, refsByInstruction.get(ins.id) ?? []));
  return createRecipe({
    id: row.id,
    title: row.title,
    servings:
      row.servings_amount != null && row.servings_amount > 0
        ? makeServings(row.servings_amount, row.servings_description ?? undefined)
        : undefined,
    ingredients,
    instructions,
    notes: row.notes ?? undefined,
    parentRecipeId: row.parent_recipe_id ?? undefined,
  });
}

export function recipeToInsert(
  recipe: Recipe,
  collectionId: string,
  sortOrder = 0,
): RecipeInsert {
  return {
    id: recipe.id,
    collection_id: collectionId,
    title: recipe.title,
    servings_amount: recipe.servings?.amount ?? null,
    servings_description: recipe.servings?.description ?? null,
    sort_order: sortOrder,
    notes: recipe.notes ?? null,
    parent_recipe_id: recipe.parentRecipeId ?? null,
  };
}

// ---- Ingredient ----

function rowToIngredient(row: IngredientRow): Ingredient {
  if (row.type === 'MEASURED') {
    const quantity = rowToQuantity(row);
    if (!quantity) {
      // Data integrity fallback: treat malformed measured rows as vague.
      return vague({
        id: row.id,
        name: row.name,
        preparation: row.preparation ?? undefined,
        notes: row.notes ?? undefined,
      });
    }
    return measured({
      id: row.id,
      name: row.name,
      quantity,
      preparation: row.preparation ?? undefined,
      notes: row.notes ?? undefined,
    });
  }
  return vague({
    id: row.id,
    name: row.name,
    preparation: row.preparation ?? undefined,
    notes: row.notes ?? undefined,
  });
}

function rowToQuantity(row: IngredientRow): Quantity | undefined {
  const unit = row.quantity_unit ?? '';
  switch (row.quantity_type) {
    case 'EXACT':
      if (row.quantity_amount == null) return undefined;
      return exact(row.quantity_amount, unit);
    case 'FRACTIONAL':
      if (
        row.quantity_whole == null ||
        row.quantity_numerator == null ||
        row.quantity_denominator == null
      )
        return undefined;
      return fractional(
        row.quantity_whole,
        row.quantity_numerator,
        row.quantity_denominator,
        unit,
      );
    case 'RANGE':
      if (row.quantity_min == null || row.quantity_max == null) return undefined;
      return range(row.quantity_min, row.quantity_max, unit);
    default:
      return undefined;
  }
}

export function ingredientToInsert(
  ing: Ingredient,
  recipeId: string,
  sortOrder: number,
): IngredientInsert {
  const base: IngredientInsert = {
    id: ing.id,
    recipe_id: recipeId,
    sort_order: sortOrder,
    type: ing.type,
    name: ing.name,
    preparation: ing.preparation ?? null,
    notes: ing.notes ?? null,
    quantity_type: null,
    quantity_amount: null,
    quantity_whole: null,
    quantity_numerator: null,
    quantity_denominator: null,
    quantity_min: null,
    quantity_max: null,
    quantity_unit: null,
  };
  if (ing.type === 'MEASURED') {
    switch (ing.quantity.type) {
      case 'EXACT':
        return {
          ...base,
          quantity_type: 'EXACT',
          quantity_amount: ing.quantity.amount,
          quantity_unit: ing.quantity.unit,
        };
      case 'FRACTIONAL':
        return {
          ...base,
          quantity_type: 'FRACTIONAL',
          quantity_whole: ing.quantity.whole,
          quantity_numerator: ing.quantity.numerator,
          quantity_denominator: ing.quantity.denominator,
          quantity_unit: ing.quantity.unit,
        };
      case 'RANGE':
        return {
          ...base,
          quantity_type: 'RANGE',
          quantity_min: ing.quantity.min,
          quantity_max: ing.quantity.max,
          quantity_unit: ing.quantity.unit,
        };
    }
  }
  return base;
}

// ---- Instruction ----

function rowToInstruction(row: InstructionRow, ingredientRefIds: string[] = []): Instruction {
  return instruction({
    id: row.id,
    stepNumber: row.step_number,
    text: row.text,
    ingredientRefs: ingredientRefIds.map((ingredientId) => ({ ingredientId })),
  });
}

export function instructionToInsert(
  step: Instruction,
  recipeId: string,
): InstructionInsert {
  return {
    id: step.id,
    recipe_id: recipeId,
    step_number: step.stepNumber,
    text: step.text,
  };
}
