// Port of `apps/web/src/import/llm.ts` parseLlmJson plus the tiny slice
// of `@cookyourbooks/domain` it depends on. Behaviour is bit-exact with
// the web copy. When you fix a bug here, fix it there too — and vice
// versa. Tests live next to the web copy.

// ---------- inlined domain types + factories ----------

export interface ExactQuantity {
  readonly type: 'EXACT';
  readonly amount: number;
  readonly unit: string;
}
export interface FractionalQuantity {
  readonly type: 'FRACTIONAL';
  readonly whole: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly unit: string;
}
export interface RangeQuantity {
  readonly type: 'RANGE';
  readonly min: number;
  readonly max: number;
  readonly unit: string;
}
export type Quantity = ExactQuantity | FractionalQuantity | RangeQuantity;

export interface MeasuredIngredient {
  readonly type: 'MEASURED';
  readonly id: string;
  readonly name: string;
  readonly quantity: Quantity;
  readonly preparation?: string;
  readonly notes?: string;
}
export interface VagueIngredient {
  readonly type: 'VAGUE';
  readonly id: string;
  readonly name: string;
  readonly preparation?: string;
  readonly notes?: string;
  readonly description?: string;
}
export type Ingredient = MeasuredIngredient | VagueIngredient;

export interface IngredientRef {
  readonly ingredientId: string;
  readonly quantity?: Quantity;
}

export type TemperatureUnit = 'FAHRENHEIT' | 'CELSIUS';
export interface Temperature {
  readonly value: number;
  readonly unit: TemperatureUnit;
}

export interface Instruction {
  readonly id: string;
  readonly stepNumber: number;
  readonly text: string;
  readonly ingredientRefs: readonly IngredientRef[];
  readonly temperature?: Temperature;
  readonly subInstructions?: readonly string[];
  readonly notes?: string;
}

export interface Servings {
  readonly amount: number;
  readonly description?: string;
  readonly amountMax?: number;
}

export interface ParsedRecipeDraft {
  title?: string;
  servings?: Servings;
  ingredients: Ingredient[];
  instructions: Instruction[];
  leftover: string[];
  description?: string;
  timeEstimate?: string;
  equipment?: string[];
  bookTitle?: string;
  pageNumbers?: number[];
  sourceImageText?: string;
}

function newId(): string {
  return crypto.randomUUID();
}

function exact(amount: number, unit: string): ExactQuantity {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('bad exact');
  return { type: 'EXACT', amount, unit };
}
function fractional(
  whole: number,
  numerator: number,
  denominator: number,
  unit: string,
): FractionalQuantity {
  if (whole < 0 || numerator < 0) throw new Error('neg');
  if (denominator <= 0) throw new Error('den');
  if (numerator >= denominator && !(whole === 0 && numerator === 0)) throw new Error('improper');
  return { type: 'FRACTIONAL', whole, numerator, denominator, unit };
}
function range(min: number, max: number, unit: string): RangeQuantity {
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('non-finite');
  if (min < 0 || max < 0) throw new Error('neg');
  if (min > max) throw new Error('inverted');
  return { type: 'RANGE', min, max, unit };
}
function measured(p: {
  name: string;
  quantity: Quantity;
  preparation?: string;
  notes?: string;
}): MeasuredIngredient {
  return { type: 'MEASURED', id: newId(), name: p.name, quantity: p.quantity, preparation: p.preparation, notes: p.notes };
}
function vague(p: {
  name: string;
  preparation?: string;
  notes?: string;
  description?: string;
}): VagueIngredient {
  return { type: 'VAGUE', id: newId(), name: p.name, preparation: p.preparation, notes: p.notes, description: p.description };
}
function instructionOf(p: {
  stepNumber: number;
  text: string;
  ingredientRefs?: readonly IngredientRef[];
  temperature?: Temperature;
  subInstructions?: readonly string[];
  notes?: string;
}): Instruction {
  return {
    id: newId(),
    stepNumber: p.stepNumber,
    text: p.text,
    ingredientRefs: [...(p.ingredientRefs ?? [])],
    temperature: p.temperature,
    subInstructions: p.subInstructions ? [...p.subInstructions] : undefined,
    notes: p.notes,
  };
}
function makeServings(amount: number, description?: string, amountMax?: number): Servings {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('bad servings');
  if (amountMax !== undefined && (!Number.isFinite(amountMax) || amountMax < amount)) {
    throw new Error('bad amountMax');
  }
  return { amount, description, amountMax };
}

// ---------- unit canonicalization (mirrors model/unit.ts) ----------

const UNITS: Record<string, { name: string; abbrev: string[] }> = {
  MILLILITER: { name: 'milliliter', abbrev: ['ml'] },
  LITER: { name: 'liter', abbrev: ['l'] },
  TEASPOON: { name: 'teaspoon', abbrev: ['tsp', 't'] },
  TABLESPOON: { name: 'tablespoon', abbrev: ['tbsp', 'tbs'] },
  CUP: { name: 'cup', abbrev: ['c'] },
  FLUID_OUNCE: { name: 'fluid ounce', abbrev: ['fl oz', 'floz'] },
  PINT: { name: 'pint', abbrev: ['pt'] },
  QUART: { name: 'quart', abbrev: ['qt'] },
  GALLON: { name: 'gallon', abbrev: ['gal'] },
  GRAM: { name: 'gram', abbrev: ['g'] },
  KILOGRAM: { name: 'kilogram', abbrev: ['kg'] },
  OUNCE: { name: 'ounce', abbrev: ['oz'] },
  POUND: { name: 'pound', abbrev: ['lb', 'lbs'] },
  PIECE: { name: 'piece', abbrev: ['pc', 'pcs'] },
  CLOVE: { name: 'clove', abbrev: [] },
  BUNCH: { name: 'bunch', abbrev: [] },
  PEOPLE: { name: 'people', abbrev: [] },
  PINCH: { name: 'pinch', abbrev: [] },
  DASH: { name: 'dash', abbrev: [] },
  HANDFUL: { name: 'handful', abbrev: [] },
  TO_TASTE: { name: 'to taste', abbrev: [] },
};
const byName = new Map<string, string>();
const byAbbr = new Map<string, string>();
const byKey = new Map<string, string>();
for (const [k, v] of Object.entries(UNITS)) {
  byName.set(v.name.toLowerCase(), v.name);
  for (const a of v.abbrev) byAbbr.set(a.toLowerCase(), v.name);
  byKey.set(k.toLowerCase(), v.name);
}
// LLMs love emitting WHOLE for countable yields — map to "piece".
byKey.set('whole', UNITS.PIECE.name);

export function canonicalUnitName(token: string | null | undefined): string {
  if (!token) return '';
  const t = token.trim();
  if (!t) return '';
  const lower = t.toLowerCase();
  return byKey.get(lower) ?? byName.get(lower) ?? byAbbr.get(lower) ?? t;
}

// ---------- parseLlmJson + helpers (mirrors llm.ts) ----------

const PARSE_FAILED = Symbol('PARSE_FAILED');

/**
 * Strict JSON.parse first. If that fails with a bad-escape error
 * (Gemini occasionally emits invalid escapes like `\T` inside string
 * values), re-try after escaping any backslash not already followed by
 * one of the valid JSON escape characters. If that also fails, return
 * the sentinel so callers can produce their own error.
 *
 * Also tolerates a stray trailing comma before `}` or `]` which Gemini
 * has been seen emitting under load.
 */
function tolerantJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const message = (err as Error).message;
    if (!/bad escaped character|unexpected token/i.test(message)) {
      return PARSE_FAILED;
    }
  }
  // Repair pass: double any backslash that isn't followed by a valid
  // JSON escape character, then collapse trailing commas.
  const repaired = text
    .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(repaired);
  } catch {
    return PARSE_FAILED;
  }
}

export function parseLlmJson(text: string): ParsedRecipeDraft[] {
  const cleaned = stripFences(text).trim();
  const raw = tolerantJsonParse(cleaned);
  if (raw === PARSE_FAILED) {
    throw new Error(`Could not parse LLM JSON. Got: ${text.slice(0, 200)}`);
  }

  let recipeObjects: unknown[];
  let rawText: string | undefined;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.rawText === 'string') rawText = obj.rawText;
    if (Array.isArray(obj.recipes)) recipeObjects = obj.recipes;
    else if (Array.isArray(obj.ingredients) || typeof obj.title === 'string')
      recipeObjects = [obj];
    else recipeObjects = [];
  } else if (Array.isArray(raw)) {
    recipeObjects = raw;
  } else {
    recipeObjects = [];
  }

  const drafts: ParsedRecipeDraft[] = [];
  for (const r of recipeObjects) {
    const draft = buildDraft(r, rawText);
    if (
      draft.title ||
      draft.ingredients.length > 0 ||
      draft.instructions.length > 0 ||
      draft.description ||
      (draft.pageNumbers && draft.pageNumbers.length > 0)
    ) {
      drafts.push(draft);
    }
  }
  if (drafts.length === 0) {
    drafts.push({
      title: undefined,
      ingredients: [],
      instructions: [],
      leftover: rawText ? [rawText] : [],
      sourceImageText: rawText,
    });
  }
  return drafts;
}

function buildDraft(raw: unknown, rawText: string | undefined): ParsedRecipeDraft {
  if (!raw || typeof raw !== 'object') {
    return { ingredients: [], instructions: [], leftover: [], sourceImageText: rawText };
  }
  const obj = raw as Record<string, unknown>;

  const ingredients: Ingredient[] = [];
  const leftover: string[] = [];
  for (const rawIng of arrayOrEmpty(obj.ingredients)) {
    const built = tryIngredient(rawIng);
    if (built) ingredients.push(built);
    else leftover.push(JSON.stringify(rawIng));
  }

  const byLowerName = new Map<string, string>();
  for (const ing of ingredients) byLowerName.set(ing.name.toLowerCase(), ing.id);
  function resolveIngredientId(name: string): string | undefined {
    const lower = name.trim().toLowerCase();
    if (!lower) return undefined;
    const exactHit = byLowerName.get(lower);
    if (exactHit) return exactHit;
    for (const [candidate, id] of byLowerName) {
      if (candidate.includes(lower) || lower.includes(candidate)) return id;
    }
    return undefined;
  }

  const instructions: Instruction[] = [];
  for (const rawStep of arrayOrEmpty(obj.instructions)) {
    const built = tryInstruction(rawStep, instructions.length + 1, resolveIngredientId);
    if (built) instructions.push(built);
  }

  const yieldServings = tryServings(obj.yield) ?? tryServings(obj.servings);
  const pageNumbers = toNumberArray(obj.pageNumbers);
  const equipment = toStringArray(obj.equipment);

  return {
    title: asTrimmedString(obj.title),
    servings: yieldServings,
    ingredients,
    instructions,
    leftover,
    description: asTrimmedString(obj.description),
    timeEstimate: asTrimmedString(obj.timeEstimate),
    equipment,
    bookTitle: asTrimmedString(obj.bookTitle),
    pageNumbers,
    sourceImageText: rawText,
  };
}

function tryIngredient(raw: unknown): Ingredient | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const name = asTrimmedString(obj.name);
  if (!name) return undefined;
  const preparation = asTrimmedString(obj.preparation);
  const notes = asTrimmedString(obj.notes);
  const description = asTrimmedString(obj.description);
  const type = typeOf(obj.type);
  if (type === 'vague') return vague({ name, preparation, notes, description });
  if (type === 'measured') {
    const q = tryQuantity(obj.quantity);
    if (!q) return vague({ name, preparation, notes, description });
    return measured({ name, preparation, notes, quantity: q });
  }
  const q = tryQuantity(obj.quantity);
  if (q) return measured({ name, preparation, notes, quantity: q });
  return vague({ name, preparation, notes, description });
}

function tryQuantity(raw: unknown): Quantity | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const t = typeOf(obj.type);
  const unit = canonicalUnitName(asString(obj.unit));
  try {
    switch (t) {
      case 'exact': {
        const n = asFiniteNumber(obj.value) ?? asFiniteNumber(obj.amount);
        if (n === undefined) return undefined;
        return exact(n, unit);
      }
      case 'fractional': {
        const w = asFiniteNumber(obj.whole);
        const num = asFiniteNumber(obj.numerator);
        const den = asFiniteNumber(obj.denominator);
        if (w === undefined || num === undefined || den === undefined) return undefined;
        return fractional(w, num, den, unit);
      }
      case 'range': {
        const min = asFiniteNumber(obj.min);
        const max = asFiniteNumber(obj.max);
        if (min === undefined || max === undefined) return undefined;
        return range(min, max, unit);
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function trySubInstructions(raw: unknown): string[] | undefined {
  const arr = asArray(raw);
  if (!arr) return undefined;
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push(t);
    } else if (item && typeof item === 'object') {
      const t = asTrimmedString((item as Record<string, unknown>).text);
      if (t) out.push(t);
    }
  }
  return out.length > 0 ? out : undefined;
}

function tryTemperature(raw: unknown): Temperature | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const value = asFiniteNumber(obj.value);
  if (value === undefined) return undefined;
  const unit = asString(obj.unit)?.toUpperCase();
  if (unit !== 'FAHRENHEIT' && unit !== 'CELSIUS') return undefined;
  return { value, unit };
}

function tryConsumedRefs(
  raw: unknown,
  resolve: (name: string) => string | undefined,
): IngredientRef[] {
  const arr = asArray(raw);
  if (!arr) return [];
  const refs: IngredientRef[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = asTrimmedString(obj.ingredientName) ?? asTrimmedString(obj.name);
    if (!name) continue;
    const id = resolve(name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({ ingredientId: id, quantity: tryQuantity(obj.quantity) });
  }
  return refs;
}

function tryInstruction(
  raw: unknown,
  fallbackStepNumber: number,
  resolveIngredientId: (name: string) => string | undefined,
): Instruction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const text = asTrimmedString(obj.text);
  if (!text) return undefined;
  const stepNumber = asFiniteNumber(obj.stepNumber) ?? fallbackStepNumber;
  return instructionOf({
    stepNumber,
    text,
    ingredientRefs: tryConsumedRefs(obj.consumedIngredients, resolveIngredientId),
    temperature: tryTemperature(obj.temperature),
    subInstructions: trySubInstructions(obj.subInstructions),
    notes: asTrimmedString(obj.notes),
  });
}

function tryServings(raw: unknown): Servings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if ('amount' in obj && !('type' in obj)) {
    const amount = asFiniteNumber(obj.amount);
    if (amount === undefined || amount <= 0) return undefined;
    try {
      return makeServings(amount, asTrimmedString(obj.description));
    } catch {
      return undefined;
    }
  }
  const q = tryQuantity(obj);
  if (!q) return undefined;
  const unitName = canonicalUnitName(q.unit);
  const description = unitName && unitName !== 'piece' ? unitName : undefined;
  try {
    switch (q.type) {
      case 'EXACT':
        return makeServings(q.amount, description);
      case 'FRACTIONAL':
        return makeServings(q.whole + q.numerator / q.denominator, description);
      case 'RANGE':
        return makeServings(q.min, description, q.max);
    }
  } catch {
    return undefined;
  }
}

// ---------- ToC parsing ----------

export interface TocEntry {
  title: string;
  page_number: number | null;
}

export function parseTocJson(text: string): TocEntry[] {
  const cleaned = stripFences(text).trim();
  const raw = tolerantJsonParse(cleaned);
  if (raw === PARSE_FAILED) {
    throw new Error(`Could not parse ToC JSON. Got: ${text.slice(0, 200)}`);
  }
  const arr =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).entries as unknown)
      : raw;
  if (!Array.isArray(arr)) return [];
  const out: TocEntry[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const title = asTrimmedString(obj.title);
    if (!title) continue;
    const page = asFiniteNumber(obj.page_number) ?? asFiniteNumber(obj.pageNumber);
    out.push({ title, page_number: page === undefined ? null : Math.round(page) });
  }
  return out;
}

// ---------- helpers ----------

function arrayOrEmpty(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}
function asArray(raw: unknown): unknown[] | undefined {
  return Array.isArray(raw) ? raw : undefined;
}
function asString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}
function asTrimmedString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}
function asFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function typeOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}
function toStringArray(raw: unknown): string[] | undefined {
  const arr = asArray(raw);
  if (!arr) return undefined;
  const out = arr.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0);
  return out.length > 0 ? out : undefined;
}
function toNumberArray(raw: unknown): number[] | undefined {
  const arr = asArray(raw);
  if (!arr) return undefined;
  const out = arr.map((x) => asFiniteNumber(x)).filter((x): x is number => x !== undefined);
  return out.length > 0 ? out : undefined;
}
function stripFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
}
