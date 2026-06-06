/**
 * A recipe tag — a per-user organizing label, distinct from the overloaded
 * `recipes.starred` flag (which is reserved for the Speed Importer queue).
 *
 * A tag is a (recipe, label) pair owned by one user. `label` is always
 * normalized (trimmed + lowercased) before persistence so "Weeknight" and
 * "weeknight " collapse to the same tag and the DB's unique constraint
 * keeps adds idempotent.
 */
export interface Tag {
  readonly id: string;
  readonly recipeId: string;
  readonly label: string;
}

export function newTagId(): string {
  return crypto.randomUUID();
}

/** Trim surrounding whitespace, collapse internal runs, and lowercase. */
export function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function createTag(params: { id?: string; recipeId: string; label: string }): Tag {
  const label = normalizeLabel(params.label);
  if (label.length === 0) {
    throw new Error('Tag label cannot be empty');
  }
  return {
    id: params.id ?? newTagId(),
    recipeId: params.recipeId,
    label,
  };
}
