import { exact, fractional, type Quantity } from '../model/quantity.js';
import { findUnit } from '../model/unit.js';
import { measured, vague, type Ingredient } from '../model/ingredient.js';

// Very small natural-language ingredient parser.
// Handles: "2 cups flour", "1 1/2 tsp salt", "3 cloves garlic, minced",
// "salt to taste" (vague), "a pinch of pepper" (vague).
export function parseIngredientLine(line: string): Ingredient | undefined {
  const trimmed = line.trim().replace(/^[-*]\s+/, '');
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (lower.includes('to taste') || lower.startsWith('a pinch') || lower.startsWith('a dash')) {
    return vague({ name: stripVaguePhrases(trimmed) });
  }

  const match = trimmed.match(
    /^(\d+(?:\s+\d+\/\d+)?|\d+\/\d+|\d+(?:\.\d+)?)\s+(\S+)\s+(.+)$/,
  );
  if (!match) {
    return vague({ name: trimmed });
  }
  const [, rawQty, rawUnit, rest] = match;
  const qty = parseQuantityText(rawQty ?? '', rawUnit ?? '');
  if (!qty) return vague({ name: trimmed });

  const { name, preparation } = splitNameAndPrep(rest ?? '');
  return measured({ name, quantity: qty, preparation });
}

function parseQuantityText(rawQty: string, rawUnit: string): Quantity | undefined {
  const unit = findUnit(rawUnit) ?? findUnit(rawUnit.replace(/s$/i, ''));
  if (!unit) return undefined;

  // Fraction like "1/2"
  const fracMatch = rawQty.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) {
    const [, n, d] = fracMatch;
    return fractional(0, Number(n), Number(d), unit.name);
  }
  // Mixed number "1 1/2"
  const mixedMatch = rawQty.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedMatch) {
    const [, w, n, d] = mixedMatch;
    return fractional(Number(w), Number(n), Number(d), unit.name);
  }
  // Decimal or integer
  const num = Number(rawQty);
  if (!Number.isFinite(num)) return undefined;
  return exact(num, unit.name);
}

function splitNameAndPrep(rest: string): { name: string; preparation?: string } {
  const commaIdx = rest.indexOf(',');
  if (commaIdx === -1) return { name: rest.trim() };
  return {
    name: rest.slice(0, commaIdx).trim(),
    preparation: rest.slice(commaIdx + 1).trim() || undefined,
  };
}

function stripVaguePhrases(s: string): string {
  return s
    .replace(/\s+to taste\b/i, '')
    .replace(/^a pinch of\s+/i, '')
    .replace(/^a dash of\s+/i, '')
    .trim();
}
