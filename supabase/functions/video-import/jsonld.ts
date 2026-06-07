// schema.org Recipe extraction for the generic-website import path.
//
// Most recipe sites embed a machine-readable copy of the recipe as
// JSON-LD (<script type="application/ld+json"> … @type: Recipe …>). When
// present it's free, exact, and avoids an LLM round-trip — so the website
// branch of video-import tries this first and only falls back to feeding
// page text to Gemini when no Recipe block exists.
//
// This module is pure (no Deno globals, no cross-imports) so it can be
// unit-tested with `deno test`. It emits the *same* JSON contract the LLM
// is prompted to produce (see VIDEO_EXTRACT_PROMPT), so the result flows
// through the shared `parseLlmJson` exactly like an LLM extraction does.

// ---------- HTML → schema.org Recipe objects ----------

const LD_JSON_RE =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** All `@type: Recipe` objects found in the page's JSON-LD blocks. */
export function extractJsonLdRecipes(html: string): Record<string, unknown>[] {
  const recipes: Record<string, unknown>[] = [];
  for (const match of html.matchAll(LD_JSON_RE)) {
    const block = match[1];
    if (!block) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue; // skip malformed blocks rather than fail the whole import
    }
    collectRecipes(parsed, recipes);
  }
  return recipes;
}

function collectRecipes(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRecipes(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  // `@graph` holds a flat list of typed entities (Article, Recipe, …).
  if (Array.isArray(obj['@graph'])) collectRecipes(obj['@graph'], out);
  if (typeIncludes(obj['@type'], 'Recipe')) out.push(obj);
}

function typeIncludes(type: unknown, want: string): boolean {
  if (typeof type === 'string') return type === want;
  if (Array.isArray(type)) return type.some((t) => t === want);
  return false;
}

// ---------- schema.org Recipe → parseLlmJson contract ----------

/**
 * Maps a schema.org Recipe object to the recipe-contract JSON object that
 * {@link parseLlmJson} consumes. Stringify `{ recipes: [ <this> ] }` and feed
 * it to parseLlmJson to get a ParsedRecipeDraft.
 */
export function schemaRecipeToContract(recipe: Record<string, unknown>): Record<string, unknown> {
  return {
    title: firstString(recipe.name),
    description: firstString(recipe.description),
    servings: parseYield(recipe.recipeYield ?? recipe.yield),
    ingredients: toStringList(recipe.recipeIngredient).map(parseIngredientContract),
    instructions: parseInstructions(recipe.recipeInstructions).map((text, i) => ({
      stepNumber: i + 1,
      text,
    })),
  };
}

// ---------- ingredient line parsing (mirrors domain/parseIngredient.ts) ----------

const UNIT_TOKENS: Record<string, string> = {};
for (const [name, abbrevs] of Object.entries({
  milliliter: ['ml'],
  liter: ['l'],
  teaspoon: ['tsp', 't'],
  tablespoon: ['tbsp', 'tbs'],
  cup: ['c'],
  'fluid ounce': ['floz'],
  pint: ['pt'],
  quart: ['qt'],
  gallon: ['gal'],
  gram: ['g'],
  kilogram: ['kg'],
  ounce: ['oz'],
  pound: ['lb', 'lbs'],
  piece: ['pc', 'pcs'],
  clove: [],
  bunch: [],
  pinch: [],
  dash: [],
  handful: [],
})) {
  UNIT_TOKENS[name] = name;
  for (const a of abbrevs) UNIT_TOKENS[a] = name;
}

function resolveUnit(token: string): string | undefined {
  const t = token.trim().toLowerCase().replace(/\.$/, '');
  return UNIT_TOKENS[t] ?? UNIT_TOKENS[t.replace(/s$/, '')];
}

/** Build a contract ingredient (measured w/ structured quantity, or vague). */
function parseIngredientContract(line: string): Record<string, unknown> {
  const trimmed = line.trim().replace(/^[-*•·]\s+/, '');
  const lower = trimmed.toLowerCase();
  if (lower.includes('to taste') || lower.startsWith('a pinch') || lower.startsWith('a dash')) {
    return { type: 'vague', name: stripVague(trimmed) };
  }
  const match = trimmed.match(/^(\d+(?:\s+\d+\/\d+)?|\d+\/\d+|\d+(?:\.\d+)?)\s+(\S+)\s+(.+)$/);
  if (!match) return { type: 'vague', name: trimmed };
  const [, rawQty, rawUnit, rest] = match;
  const unit = resolveUnit(rawUnit ?? '');
  if (!unit) return { type: 'vague', name: trimmed };
  const quantity = parseQuantity(rawQty ?? '', unit);
  if (!quantity) return { type: 'vague', name: trimmed };
  const { name, preparation } = splitNameAndPrep(rest ?? '');
  return { type: 'measured', name, quantity, preparation };
}

function parseQuantity(rawQty: string, unit: string): Record<string, unknown> | undefined {
  const frac = rawQty.match(/^(\d+)\/(\d+)$/);
  if (frac) return { type: 'fractional', whole: 0, numerator: +frac[1]!, denominator: +frac[2]!, unit };
  const mixed = rawQty.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    return { type: 'fractional', whole: +mixed[1]!, numerator: +mixed[2]!, denominator: +mixed[3]!, unit };
  }
  const num = Number(rawQty);
  if (!Number.isFinite(num)) return undefined;
  return { type: 'exact', value: num, unit };
}

function splitNameAndPrep(rest: string): { name: string; preparation?: string } {
  const comma = rest.indexOf(',');
  if (comma === -1) return { name: rest.trim() };
  return { name: rest.slice(0, comma).trim(), preparation: rest.slice(comma + 1).trim() || undefined };
}

function stripVague(s: string): string {
  return s
    .replace(/\s+to taste\b/i, '')
    .replace(/^a pinch of\s+/i, '')
    .replace(/^a dash of\s+/i, '')
    .trim();
}

// ---------- instructions ----------

/** Flattens schema.org recipeInstructions (string | HowToStep | HowToSection). */
function parseInstructions(raw: unknown): string[] {
  const out: string[] = [];
  walkInstructions(raw, out);
  return out.filter((t) => t.length > 0);
}

function walkInstructions(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    // A single string may itself be multi-line / multi-step text.
    for (const part of node.split(/\r?\n+/)) {
      const t = part.trim();
      if (t) out.push(t);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkInstructions(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  // HowToSection wraps steps in itemListElement.
  if (Array.isArray(obj.itemListElement)) {
    walkInstructions(obj.itemListElement, out);
    return;
  }
  const text = firstString(obj.text) ?? firstString(obj.name);
  if (text) out.push(text);
}

// ---------- yield ----------

function parseYield(raw: unknown): Record<string, unknown> | undefined {
  const candidates = Array.isArray(raw) ? raw : [raw];
  for (const c of candidates) {
    const s = typeof c === 'number' ? String(c) : typeof c === 'string' ? c : '';
    const m = s.match(/\d+/);
    if (m) {
      const amount = Number(m[0]);
      if (Number.isFinite(amount) && amount > 0) return { amount };
    }
  }
  return undefined;
}

// ---------- site name ----------

/** Friendly per-domain collection title: og:site_name, else the hostname. */
export function extractSiteName(html: string, url: string): string {
  const og = html.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og?.[1]) return og[1].trim();
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Web';
  }
}

// ---------- helpers ----------

function firstString(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t.length > 0 ? t : undefined;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const s = firstString(item);
      if (s) return s;
    }
  }
  return undefined;
}

function toStringList(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) {
    return raw.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0);
  }
  return [];
}
