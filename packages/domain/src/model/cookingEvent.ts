import { isMeasured } from './ingredient.js';
import { formatQuantity } from './quantity.js';
import type { Recipe } from './recipe.js';

/**
 * A cooking event is the act of cooking a recipe, not the recipe itself.
 *
 *   - PLANNED — "make this on <date>" (a forward-looking schedule entry).
 *   - COOKED  — "I made this" (a history / diary entry).
 *
 * A PLANNED event becomes COOKED via `markCooked` (immutable transition).
 * Everything here is a pure, immutable value — transformations return new
 * instances, matching the rest of the domain.
 */
export type CookingEventStatus = 'PLANNED' | 'COOKED';

/**
 * Coarse occasion category. App-level enum — the DB stores it as free text
 * with no CHECK, so new categories never need a migration. `OTHER` pairs
 * with `occasionNote` for anything that doesn't fit.
 */
export type OccasionCategory = 'MEAL' | 'CELEBRATION' | 'PRACTICE' | 'MEAL_PREP' | 'OTHER';

/** Day-part of a cook. App-level enum (DB stores free text, no CHECK). */
export type MealSlot = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK';

/**
 * A single structured change the cook made relative to the recipe as
 * written. Discriminated union tagged with `type` (domain convention).
 *
 * Each variant snapshots the human-readable "from" label (`fromName` /
 * `fromText`) at record time so the diary stays legible even if the recipe
 * is later edited or deleted. The `*Id` fields are kept for "jump to the
 * live ingredient/step" affordances but are not load-bearing for display.
 */
export type RecipeAdjustment =
  | {
      readonly type: 'INGREDIENT_SWAP';
      readonly ingredientId: string;
      readonly fromName: string;
      readonly toText: string;
      readonly note?: string;
    }
  | {
      readonly type: 'INGREDIENT_OMIT';
      readonly ingredientId: string;
      readonly fromName: string;
      readonly note?: string;
    }
  | {
      readonly type: 'INGREDIENT_ADD';
      readonly toText: string;
      readonly note?: string;
    }
  | {
      readonly type: 'INSTRUCTION_SWAP';
      readonly instructionId: string;
      readonly stepNumber: number;
      readonly fromText: string;
      readonly toText: string;
      readonly note?: string;
    }
  | {
      readonly type: 'INSTRUCTION_SKIP';
      readonly instructionId: string;
      readonly stepNumber: number;
      readonly fromText: string;
      readonly note?: string;
    };

/**
 * Lightweight, durable snapshot of the essential recipe graph at cook
 * time. Deliberately omits OCR blobs / source metadata so cooking_events
 * rows (which are also pulled for every household co-member) stay small.
 */
export interface RecipeSnapshotIngredient {
  readonly name: string;
  readonly quantityText?: string;
  readonly preparation?: string;
}

export interface RecipeSnapshotInstruction {
  readonly stepNumber: number;
  readonly text: string;
}

export interface RecipeSnapshot {
  readonly title: string;
  readonly ingredients: readonly RecipeSnapshotIngredient[];
  readonly instructions: readonly RecipeSnapshotInstruction[];
}

export interface CookingEvent {
  readonly id: string;
  /** The recipe this event is about. May be null once that recipe is deleted. */
  readonly recipeId: string | null;
  readonly status: CookingEventStatus;
  /** ISO day-only date, 'YYYY-MM-DD'. */
  readonly eventDate: string;
  readonly occasionCategory?: OccasionCategory;
  /** Day-part: breakfast / lunch / dinner / snack. */
  readonly mealSlot?: MealSlot;
  /** Free-form occasion ("Mum's birthday", "Date night"). */
  readonly occasionNote?: string;
  readonly notes?: string;
  readonly adjustments: readonly RecipeAdjustment[];
  /** Storage paths of photos attached to this entry (in the cooking-photos bucket). */
  readonly photoPaths: readonly string[];
  /** Present on COOKED events for durability; absent on PLANNED. */
  readonly recipeSnapshot?: RecipeSnapshot;
}

export function newCookingEventId(): string {
  return crypto.randomUUID();
}

/** Build a durable snapshot from a hydrated recipe. */
export function snapshotOfRecipe(recipe: Recipe): RecipeSnapshot {
  return {
    title: recipe.title,
    ingredients: recipe.ingredients.map((ing) => ({
      name: ing.name,
      quantityText: isMeasured(ing) ? formatQuantity(ing.quantity) : undefined,
      preparation: ing.preparation,
    })),
    instructions: recipe.instructions.map((step) => ({
      stepNumber: step.stepNumber,
      text: step.text,
    })),
  };
}

interface BaseEventParams {
  id?: string;
  recipeId: string;
  eventDate: string;
  occasionCategory?: OccasionCategory;
  mealSlot?: MealSlot;
  occasionNote?: string;
  notes?: string;
  adjustments?: readonly RecipeAdjustment[];
  photoPaths?: readonly string[];
}

/** Create a PLANNED "make this on <date>" event. No snapshot. */
export function planCook(params: BaseEventParams): CookingEvent {
  return {
    id: params.id ?? newCookingEventId(),
    recipeId: params.recipeId,
    status: 'PLANNED',
    eventDate: params.eventDate,
    occasionCategory: params.occasionCategory,
    mealSlot: params.mealSlot,
    occasionNote: params.occasionNote,
    notes: params.notes,
    adjustments: [...(params.adjustments ?? [])],
    photoPaths: [...(params.photoPaths ?? [])],
  };
}

/** Create a COOKED "I made this" event. Requires a snapshot for durability. */
export function logCook(params: BaseEventParams & { snapshot: RecipeSnapshot }): CookingEvent {
  return {
    id: params.id ?? newCookingEventId(),
    recipeId: params.recipeId,
    status: 'COOKED',
    eventDate: params.eventDate,
    occasionCategory: params.occasionCategory,
    mealSlot: params.mealSlot,
    occasionNote: params.occasionNote,
    notes: params.notes,
    adjustments: [...(params.adjustments ?? [])],
    photoPaths: [...(params.photoPaths ?? [])],
    recipeSnapshot: params.snapshot,
  };
}

/**
 * Transition a PLANNED event to COOKED, capturing the recipe snapshot at
 * the moment it was actually made. Returns a new instance; the input is
 * left untouched.
 */
export function markCooked(event: CookingEvent, snapshot: RecipeSnapshot): CookingEvent {
  return {
    ...event,
    status: 'COOKED',
    recipeSnapshot: snapshot,
  };
}

export function isPlanned(e: CookingEvent): boolean {
  return e.status === 'PLANNED';
}

export function isCooked(e: CookingEvent): boolean {
  return e.status === 'COOKED';
}
