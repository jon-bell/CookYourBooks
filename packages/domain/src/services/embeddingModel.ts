import type { Recipe } from '../model/recipe.js';

// Pinned model identity. Both the browser and the Deno Edge Function
// load weights against this id; bumping it requires re-embedding the
// whole corpus (delete from recipe_embeddings where model <> $current
// then re-enqueue jobs). The text_hash + model columns let the worker
// short-circuit a recompute when neither has drifted.
export const EMBEDDING_MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIM = 384;

/**
 * Build the text we feed the embedding model for a recipe. Stable +
 * deterministic so the same recipe always produces the same SHA-256
 * hash, regardless of which runtime computed it. Order matters because
 * we hash the result.
 *
 * Scope (per the design): title, description, ingredients (name +
 * description / preparation), notes, book title, equipment. We
 * deliberately skip instruction text — it's noisy and dominated by
 * cooking verbs that crowd out the more useful "what is this recipe
 * about" signal.
 */
export function buildRecipeEmbedText(recipe: Recipe): string {
  const parts: string[] = [];
  parts.push(`Title: ${recipe.title.trim()}`);
  if (recipe.bookTitle && recipe.bookTitle.trim()) {
    parts.push(`Cookbook: ${recipe.bookTitle.trim()}`);
  }
  if (recipe.description && recipe.description.trim()) {
    parts.push(`Description: ${recipe.description.trim()}`);
  }
  if (recipe.equipment && recipe.equipment.length > 0) {
    const eq = recipe.equipment.map((e) => e.trim()).filter(Boolean);
    if (eq.length > 0) parts.push(`Equipment: ${eq.join(', ')}`);
  }
  const ingredientLines: string[] = [];
  for (const ing of recipe.ingredients) {
    const name = ing.name.trim();
    if (!name) continue;
    let line = name;
    if (ing.preparation && ing.preparation.trim()) {
      line += ` (${ing.preparation.trim()})`;
    }
    if (ing.type === 'VAGUE' && ing.description && ing.description.trim()) {
      line += ` — ${ing.description.trim()}`;
    }
    ingredientLines.push(line);
  }
  if (ingredientLines.length > 0) {
    parts.push(`Ingredients: ${ingredientLines.join('; ')}`);
  }
  if (recipe.notes && recipe.notes.trim()) {
    parts.push(`Notes: ${recipe.notes.trim()}`);
  }
  return parts.join('\n');
}

/**
 * Stable SHA-256 of the embed text. Used in both runtimes to decide
 * whether a recipe needs re-embedding. Returns lowercase hex.
 *
 * Web Crypto's SubtleCrypto is available in modern browsers, Workers,
 * and Deno — so the same call works in both worker and client paths.
 */
export async function hashEmbedText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i += 1) {
    out += view[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
