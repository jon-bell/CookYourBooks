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

// Accept either a native JS array (Postgres jsonb → parsed) or a JSON
// string (the local-SQLite mirror stores these as TEXT). `undefined`
// or malformed inputs produce `undefined` so callers can .. ?? default.
function jsonArray<T>(raw: unknown): T[] | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
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
  const out = arr.filter(
    (x): x is number => typeof x === 'number' && Number.isFinite(x),
  );
  return out.length > 0 ? out : undefined;
}

export function rowsToRecipe(
  row: RecipeRow,
  ingredientRows: IngredientRow[],
  instructionRows: InstructionRow[],
  refRows: InstructionRefRow[] = [],
): Recipe {
  const ingredients = [...ingredientRows]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(rowToIngredient);
  // Index refs by instruction id, preserving any per-step consumed
  // quantities. We pass the raw ref rows through so the instruction
  // mapper can read the `consumed_quantity_*` columns.
  const refsByInstruction = new Map<string, InstructionRefRow[]>();
  for (const r of refRows) {
    const list = refsByInstruction.get(r.instruction_id) ?? [];
    list.push(r);
    refsByInstruction.set(r.instruction_id, list);
  }
  const instructions = [...instructionRows]
    .sort((a, b) => a.step_number - b.step_number)
    .map((ins) => rowToInstruction(ins, refsByInstruction.get(ins.id) ?? []));
  const rowX = row as RecipeRow & {
    servings_amount_max?: number | null;
    description?: string | null;
    time_estimate?: string | null;
    equipment?: unknown;
    book_title?: string | null;
    page_numbers?: unknown;
    source_image_text?: string | null;
  };
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
  });
}

export function recipeToInsert(
  recipe: Recipe,
  collectionId: string,
  sortOrder = 0,
): RecipeInsert {
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
  };
  return { ...base, ...extras } as RecipeInsert;
}

// ---- Ingredient ----

function rowToIngredient(row: IngredientRow): Ingredient {
  const rowX = row as IngredientRow & { description?: string | null };
  const description = rowX.description ?? undefined;
  if (row.type === 'MEASURED') {
    const quantity = rowToQuantity(row);
    if (!quantity) {
      // Data integrity fallback: treat malformed measured rows as vague.
      return vague({
        id: row.id,
        name: row.name,
        preparation: row.preparation ?? undefined,
        notes: row.notes ?? undefined,
        description,
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
    description,
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
    description: ing.type === 'VAGUE' ? (ing.description ?? null) : null,
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

function refRowToQuantity(row: InstructionRefRow): Quantity | undefined {
  const r = row as InstructionRefRow & {
    consumed_quantity_type?: string | null;
    consumed_quantity_amount?: number | null;
    consumed_quantity_whole?: number | null;
    consumed_quantity_numerator?: number | null;
    consumed_quantity_denominator?: number | null;
    consumed_quantity_min?: number | null;
    consumed_quantity_max?: number | null;
    consumed_quantity_unit?: string | null;
  };
  const unit = r.consumed_quantity_unit ?? '';
  try {
    switch (r.consumed_quantity_type) {
      case 'EXACT':
        if (r.consumed_quantity_amount == null) return undefined;
        return exact(r.consumed_quantity_amount, unit);
      case 'FRACTIONAL':
        if (
          r.consumed_quantity_whole == null ||
          r.consumed_quantity_numerator == null ||
          r.consumed_quantity_denominator == null
        )
          return undefined;
        return fractional(
          r.consumed_quantity_whole,
          r.consumed_quantity_numerator,
          r.consumed_quantity_denominator,
          unit,
        );
      case 'RANGE':
        if (r.consumed_quantity_min == null || r.consumed_quantity_max == null)
          return undefined;
        return range(r.consumed_quantity_min, r.consumed_quantity_max, unit);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function rowToInstruction(row: InstructionRow, refRows: InstructionRefRow[] = []): Instruction {
  const rowX = row as InstructionRow & {
    temperature_value?: number | null;
    temperature_unit?: string | null;
    sub_instructions?: unknown;
    notes?: string | null;
  };
  const temperature =
    rowX.temperature_value != null &&
    (rowX.temperature_unit === 'FAHRENHEIT' || rowX.temperature_unit === 'CELSIUS')
      ? {
          value: rowX.temperature_value,
          unit: rowX.temperature_unit as 'FAHRENHEIT' | 'CELSIUS',
        }
      : undefined;
  const subInstructions = stringArray(rowX.sub_instructions);
  return instruction({
    id: row.id,
    stepNumber: row.step_number,
    text: row.text,
    ingredientRefs: refRows.map((r) => ({
      ingredientId: r.ingredient_id,
      quantity: refRowToQuantity(r),
    })),
    temperature,
    subInstructions,
    notes: rowX.notes ?? undefined,
  });
}

export function instructionRefToInsert(
  instructionId: string,
  ingredientId: string,
  quantity: Quantity | undefined,
): InstructionRefInsert {
  const base: InstructionRefInsert = {
    instruction_id: instructionId,
    ingredient_id: ingredientId,
    consumed_quantity_type: null,
    consumed_quantity_amount: null,
    consumed_quantity_whole: null,
    consumed_quantity_numerator: null,
    consumed_quantity_denominator: null,
    consumed_quantity_min: null,
    consumed_quantity_max: null,
    consumed_quantity_unit: null,
  };
  if (!quantity) return base;
  switch (quantity.type) {
    case 'EXACT':
      return {
        ...base,
        consumed_quantity_type: 'EXACT',
        consumed_quantity_amount: quantity.amount,
        consumed_quantity_unit: quantity.unit,
      };
    case 'FRACTIONAL':
      return {
        ...base,
        consumed_quantity_type: 'FRACTIONAL',
        consumed_quantity_whole: quantity.whole,
        consumed_quantity_numerator: quantity.numerator,
        consumed_quantity_denominator: quantity.denominator,
        consumed_quantity_unit: quantity.unit,
      };
    case 'RANGE':
      return {
        ...base,
        consumed_quantity_type: 'RANGE',
        consumed_quantity_min: quantity.min,
        consumed_quantity_max: quantity.max,
        consumed_quantity_unit: quantity.unit,
      };
  }
}

export function instructionToInsert(
  step: Instruction,
  recipeId: string,
): InstructionInsert {
  const base: InstructionInsert = {
    id: step.id,
    recipe_id: recipeId,
    step_number: step.stepNumber,
    text: step.text,
  };
  const extras: Record<string, unknown> = {
    temperature_value: step.temperature?.value ?? null,
    temperature_unit: step.temperature?.unit ?? null,
    sub_instructions: step.subInstructions ? [...step.subInstructions] : null,
    notes: step.notes ?? null,
  };
  return { ...base, ...extras } as InstructionInsert;
}
