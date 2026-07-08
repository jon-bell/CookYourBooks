// Canonical JSON contract for recipe children (ingredients + instructions).
//
// Children used to live in the normalized `ingredients` /
// `instructions` / `instruction_ingredient_refs` tables. They now ride
// as two JSONB columns on the recipe row (`recipes.ingredients`,
// `recipes.instructions`). The keys below are camelCase = the domain
// field names, so serialization is near-identity with the
// `@cookyourbooks/domain` model.
//
// This shape is the WIRE CONTRACT: the server backfill / RPC SQL emit
// exactly these keys, and the local-SQLite mirror stores them as JSON
// text. The round-trip test in `recipeJson.test.ts` is the contract.
//
// Array position IS the order — we drop the DB-only `sort_order`.
// `stepNumber` is kept because it's a domain field.

import {
  exact,
  fractional,
  type Ingredient,
  type Instruction,
  instruction,
  type LinkSource,
  measured,
  type Quantity,
  range,
  type Recipe,
  type SimplifiedStep,
  type Temperature,
  vague,
} from '@cookyourbooks/domain';

const LINK_SOURCES: readonly LinkSource[] = ['auto', 'manual', 'dismissed'];
function toLinkSource(v: unknown): LinkSource | undefined {
  return typeof v === 'string' && (LINK_SOURCES as readonly string[]).includes(v)
    ? (v as LinkSource)
    : undefined;
}

export type StoredQuantity =
  | { type: 'EXACT'; amount: number; unit: string }
  | { type: 'FRACTIONAL'; whole: number; numerator: number; denominator: number; unit: string }
  | { type: 'RANGE'; min: number; max: number; unit: string };

export interface StoredIngredient {
  id: string;
  type: 'MEASURED' | 'VAGUE';
  name: string;
  preparation?: string;
  notes?: string;
  description?: string; // VAGUE only
  quantity?: StoredQuantity; // MEASURED only
  linkedRecipeId?: string; // ingredient-recipe cross-reference (#102)
  linkSource?: LinkSource;
}

export interface StoredIngredientRef {
  ingredientId: string;
  quantity?: StoredQuantity; // per-step consumed qty (was consumed_quantity_*)
}

export interface StoredSimplifiedStep {
  text: string;
  durationSec?: number;
  temperature?: { value: number; unit: 'FAHRENHEIT' | 'CELSIUS' };
  notes?: string;
}

export interface StoredInstruction {
  id: string;
  stepNumber: number;
  text: string;
  temperature?: { value: number; unit: 'FAHRENHEIT' | 'CELSIUS' };
  subInstructions?: string[];
  simplifiedSteps?: StoredSimplifiedStep[];
  notes?: string;
  ingredientRefs?: StoredIngredientRef[];
}

// ---------- serialize (domain → JSON) ----------

function quantityToStored(q: Quantity): StoredQuantity {
  switch (q.type) {
    case 'EXACT':
      return { type: 'EXACT', amount: q.amount, unit: q.unit };
    case 'FRACTIONAL':
      return {
        type: 'FRACTIONAL',
        whole: q.whole,
        numerator: q.numerator,
        denominator: q.denominator,
        unit: q.unit,
      };
    case 'RANGE':
      return { type: 'RANGE', min: q.min, max: q.max, unit: q.unit };
  }
}

function ingredientToStored(ing: Ingredient): StoredIngredient {
  const base: StoredIngredient = { id: ing.id, type: ing.type, name: ing.name };
  if (ing.preparation) base.preparation = ing.preparation;
  if (ing.notes) base.notes = ing.notes;
  if (ing.type === 'MEASURED') {
    base.quantity = quantityToStored(ing.quantity);
  } else if (ing.description) {
    base.description = ing.description;
  }
  if (ing.linkedRecipeId) base.linkedRecipeId = ing.linkedRecipeId;
  if (ing.linkSource) base.linkSource = ing.linkSource;
  return base;
}

function instructionToStored(step: Instruction): StoredInstruction {
  const out: StoredInstruction = {
    id: step.id,
    stepNumber: step.stepNumber,
    text: step.text,
  };
  if (step.temperature) out.temperature = { ...step.temperature };
  if (step.subInstructions && step.subInstructions.length > 0) {
    out.subInstructions = [...step.subInstructions];
  }
  if (step.simplifiedSteps) {
    // Preserve the explicit-empty-array sentinel ("user dismissed").
    out.simplifiedSteps = step.simplifiedSteps.map((s) => {
      const e: StoredSimplifiedStep = { text: s.text };
      if (s.durationSec != null) e.durationSec = s.durationSec;
      if (s.temperature) e.temperature = { ...s.temperature };
      if (s.notes) e.notes = s.notes;
      return e;
    });
  }
  if (step.notes) out.notes = step.notes;
  if (step.ingredientRefs.length > 0) {
    out.ingredientRefs = step.ingredientRefs.map((r) => {
      const ref: StoredIngredientRef = { ingredientId: r.ingredientId };
      if (r.quantity) ref.quantity = quantityToStored(r.quantity);
      return ref;
    });
  }
  return out;
}

export function serializeChildren(recipe: Recipe): {
  ingredients: StoredIngredient[];
  instructions: StoredInstruction[];
} {
  return {
    ingredients: recipe.ingredients.map(ingredientToStored),
    instructions: recipe.instructions.map(instructionToStored),
  };
}

// ---------- deserialize (JSON → domain), tolerant ----------

// Accept a native array (Postgres jsonb → parsed by supabase-js) or a
// JSON string (local-SQLite TEXT). Malformed / empty → [].
function toArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw === null || raw === undefined || raw === '') return [];
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function storedToQuantity(raw: unknown): Quantity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const q = raw as Record<string, unknown>;
  const unit = typeof q.unit === 'string' ? q.unit : '';
  try {
    switch (q.type) {
      case 'EXACT': {
        const amount = num(q.amount);
        return amount == null ? undefined : exact(amount, unit);
      }
      case 'FRACTIONAL': {
        const whole = num(q.whole);
        const numerator = num(q.numerator);
        const denominator = num(q.denominator);
        if (whole == null || numerator == null || denominator == null) return undefined;
        return fractional(whole, numerator, denominator, unit);
      }
      case 'RANGE': {
        const min = num(q.min);
        const max = num(q.max);
        if (min == null || max == null) return undefined;
        return range(min, max, unit);
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function storedToTemperature(raw: unknown): Temperature | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const value = num(t.value);
  const unit = t.unit === 'FAHRENHEIT' || t.unit === 'CELSIUS' ? t.unit : undefined;
  if (value == null || unit == null) return undefined;
  return { value, unit };
}

function storedToSimplifiedSteps(raw: unknown): SimplifiedStep[] | undefined {
  if (raw === undefined) return undefined;
  const arr = toArray(raw);
  // Preserve explicit-empty-array (dismissal) sentinel.
  if (arr.length === 0) return Array.isArray(raw) ? [] : undefined;
  const out: SimplifiedStep[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (!text) continue;
    const step: {
      text: string;
      durationSec?: number;
      temperature?: Temperature;
      notes?: string;
    } = { text };
    const duration = num(e.durationSec);
    if (duration != null && duration > 0) step.durationSec = Math.round(duration);
    const temperature = storedToTemperature(e.temperature);
    if (temperature) step.temperature = temperature;
    const notes = str(typeof e.notes === 'string' ? e.notes.trim() : undefined);
    if (notes) step.notes = notes;
    out.push(step);
  }
  return out.length > 0 ? out : [];
}

function storedToIngredient(raw: unknown): Ingredient | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const i = raw as Record<string, unknown>;
  const id = str(i.id);
  const name = typeof i.name === 'string' ? i.name : '';
  if (!id) return undefined;
  const preparation = str(i.preparation);
  const notes = str(i.notes);
  const linkedRecipeId = str(i.linkedRecipeId);
  const linkSource = toLinkSource(i.linkSource);
  if (i.type === 'MEASURED') {
    const quantity = storedToQuantity(i.quantity);
    // Data-integrity fallback: a malformed measured ingredient degrades
    // to vague rather than throwing (mirrors the old row mapper).
    if (!quantity) {
      return vague({
        id,
        name,
        preparation,
        notes,
        description: str(i.description),
        linkedRecipeId,
        linkSource,
      });
    }
    return measured({ id, name, quantity, preparation, notes, linkedRecipeId, linkSource });
  }
  return vague({
    id,
    name,
    preparation,
    notes,
    description: str(i.description),
    linkedRecipeId,
    linkSource,
  });
}

function storedToInstruction(raw: unknown): Instruction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const id = str(s.id);
  if (!id) return undefined;
  const refsRaw = toArray(s.ingredientRefs);
  const ingredientRefs = refsRaw
    .map((r) => {
      if (!r || typeof r !== 'object') return undefined;
      const ref = r as Record<string, unknown>;
      const ingredientId = str(ref.ingredientId);
      if (!ingredientId) return undefined;
      return { ingredientId, quantity: storedToQuantity(ref.quantity) };
    })
    .filter((r): r is { ingredientId: string; quantity: Quantity | undefined } => r !== undefined);
  return instruction({
    id,
    stepNumber: num(s.stepNumber) ?? 0,
    text: typeof s.text === 'string' ? s.text : '',
    ingredientRefs,
    temperature: storedToTemperature(s.temperature),
    subInstructions: (() => {
      const arr = toArray(s.subInstructions).filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
      );
      return arr.length > 0 ? arr : undefined;
    })(),
    simplifiedSteps: storedToSimplifiedSteps(s.simplifiedSteps),
    notes: str(s.notes),
  });
}

export function deserializeChildren(
  ingredientsRaw: unknown,
  instructionsRaw: unknown,
): { ingredients: Ingredient[]; instructions: Instruction[] } {
  const ingredients = toArray(ingredientsRaw)
    .map(storedToIngredient)
    .filter((i): i is Ingredient => i !== undefined);
  const instructions = toArray(instructionsRaw)
    .map(storedToInstruction)
    .filter((i): i is Instruction => i !== undefined);
  return { ingredients, instructions };
}

// Lowercased, space-joined ingredient names — backs the local-SQLite
// ingredient-name search (the old correlated EXISTS over `ingredients`).
export function ingredientsSearchText(recipe: Recipe): string {
  return recipe.ingredients
    .map((i) => i.name.toLowerCase())
    .filter((n) => n.length > 0)
    .join(' ');
}

// Same, but from already-serialized Stored ingredients (used on the write
// path where we have the JSON, not a domain Recipe).
export function storedIngredientsSearchText(ingredients: StoredIngredient[]): string {
  return ingredients
    .map((i) => (typeof i.name === 'string' ? i.name.toLowerCase() : ''))
    .filter((n) => n.length > 0)
    .join(' ');
}

// ---------- legacy flat rows → Stored (local backfill only) ----------
//
// Folds the pre-2026-07-08 flat child-table rows (quantity_* columns,
// separate refs) into the Stored JSON contract. Used exclusively by the
// on-device `recipe_jsonb_v1` backfill; the child tables are gone
// server-side, so this never runs against Postgres.

function flatQuantity(r: Record<string, unknown>, prefix: string): StoredQuantity | undefined {
  const type = r[`${prefix}type`];
  const unit = typeof r[`${prefix}unit`] === 'string' ? (r[`${prefix}unit`] as string) : '';
  const n = (k: string): number | undefined => num(r[`${prefix}${k}`]);
  switch (type) {
    case 'EXACT': {
      const amount = n('amount');
      return amount == null ? undefined : { type: 'EXACT', amount, unit };
    }
    case 'FRACTIONAL': {
      const whole = n('whole');
      const numerator = n('numerator');
      const denominator = n('denominator');
      if (whole == null || numerator == null || denominator == null) return undefined;
      return { type: 'FRACTIONAL', whole, numerator, denominator, unit };
    }
    case 'RANGE': {
      const min = n('min');
      const max = n('max');
      if (min == null || max == null) return undefined;
      return { type: 'RANGE', min, max, unit };
    }
    default:
      return undefined;
  }
}

export function legacyChildRowsToStored(
  ingredientRows: readonly Record<string, unknown>[],
  instructionRows: readonly Record<string, unknown>[],
  refRows: readonly Record<string, unknown>[],
): { ingredients: StoredIngredient[]; instructions: StoredInstruction[] } {
  const ingredients: StoredIngredient[] = [...ingredientRows]
    .sort((a, b) => (num(a.sort_order) ?? 0) - (num(b.sort_order) ?? 0))
    .map((r) => {
      const out: StoredIngredient = {
        id: str(r.id) ?? '',
        type: r.type === 'MEASURED' ? 'MEASURED' : 'VAGUE',
        name: typeof r.name === 'string' ? r.name : '',
      };
      const preparation = str(r.preparation);
      if (preparation) out.preparation = preparation;
      const notes = str(r.notes);
      if (notes) out.notes = notes;
      if (out.type === 'MEASURED') {
        const q = flatQuantity(r, 'quantity_');
        if (q) out.quantity = q;
        else {
          out.type = 'VAGUE';
          const description = str(r.description);
          if (description) out.description = description;
        }
      } else {
        const description = str(r.description);
        if (description) out.description = description;
      }
      const linkedRecipeId = str(r.linked_recipe_id);
      if (linkedRecipeId) out.linkedRecipeId = linkedRecipeId;
      const linkSource = toLinkSource(r.link_source);
      if (linkSource) out.linkSource = linkSource;
      return out;
    });

  const refsByInstruction = new Map<string, StoredIngredientRef[]>();
  for (const ref of refRows) {
    const iid = str(ref.instruction_id);
    const ingredientId = str(ref.ingredient_id);
    if (!iid || !ingredientId) continue;
    const stored: StoredIngredientRef = { ingredientId };
    const q = flatQuantity(ref, 'consumed_quantity_');
    if (q) stored.quantity = q;
    const list = refsByInstruction.get(iid) ?? [];
    list.push(stored);
    refsByInstruction.set(iid, list);
  }

  const instructions: StoredInstruction[] = [...instructionRows]
    .sort((a, b) => (num(a.step_number) ?? 0) - (num(b.step_number) ?? 0))
    .map((r) => {
      const id = str(r.id) ?? '';
      const out: StoredInstruction = {
        id,
        stepNumber: num(r.step_number) ?? 0,
        text: typeof r.text === 'string' ? r.text : '',
      };
      const temperature = storedToTemperature({
        value: num(r.temperature_value),
        unit: r.temperature_unit,
      });
      if (temperature) out.temperature = temperature;
      const subs = toArray(r.sub_instructions).filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
      );
      if (subs.length > 0) out.subInstructions = subs;
      const simplified = storedToSimplifiedSteps(r.simplified_steps);
      if (simplified) out.simplifiedSteps = simplified;
      const notes = str(r.notes);
      if (notes) out.notes = notes;
      const refs = refsByInstruction.get(id);
      if (refs && refs.length > 0) out.ingredientRefs = refs;
      return out;
    });

  return { ingredients, instructions };
}
