// Ingredient → recipe cross-reference matcher.
//
// Links an ingredient whose name IS another recipe in the SAME collection
// (a component / sub-recipe — "Almond and Cherry Cream Pie" calls for
// "Double Almond Crust"). Same-collection is enforced by the caller: the
// index passed in is built from the host recipe's own collection only, so
// an auto-link can never cross books. Manual links (elsewhere) may cross.
//
// Matching is lexical and deliberately FULL-PHRASE. We do NOT reduce to a
// head noun the way extractIngredientTerms does — "Double Almond Crust"
// must match the recipe "Double Almond Crust", not every recipe whose
// title happens to end in "crust". Within a book we match aggressively:
// exact title equality plus a "title contained in the ingredient name"
// pass (for "Sous Vide Fish Stock (see page 87)" and "unsweetened
// pomegranate molasses"). Placeholder targets (not-yet-OCR'd recipes) are
// valid — they fill in later.

export interface CollectionTitleEntry {
  recipeId: string;
  title: string;
  /** false for OCR'd table-of-contents placeholders (title only). */
  hasContent: boolean;
}

/** normalized-title → entries (a title can be shared by more than one recipe). */
export type TitleIndex = Map<string, CollectionTitleEntry[]>;

export interface LinkMatch {
  recipeId: string;
  /** true when the target is a placeholder (lets the UI hint "not imported yet"). */
  isPlaceholder: boolean;
}

/**
 * Lowercase, collapse every run of non-alphanumeric characters to a single
 * space, trim. Punctuation (hyphens, parens, %, commas, quotes) becomes a
 * word boundary so "Ginger-Garlic Paste" and "ginger garlic paste" — and
 * "PEPPERCORN SAUCE" and "Peppercorn sauce" — compare equal.
 */
export function normalizeForLink(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(norm: string): number {
  return norm.length === 0 ? 0 : norm.split(' ').length;
}

const DIGITS_ONLY = /^\d+$/;

export function buildTitleIndex(entries: Iterable<CollectionTitleEntry>): TitleIndex {
  const idx: TitleIndex = new Map();
  for (const e of entries) {
    const key = normalizeForLink(e.title);
    if (!key) continue;
    const arr = idx.get(key);
    if (arr) arr.push(e);
    else idx.set(key, [e]);
  }
  return idx;
}

// Exact-match candidate phrases for an ingredient name, most-cleaned first.
// Parentheticals ("(see page 87)", "(for sauce)") are dropped; a trailing
// comma clause ("Sous Vide Chicken, warm and sliced") is prep noise, so the
// text before the first comma is tried first.
function exactCandidates(name: string): string[] {
  const noParens = name.replace(/\([^)]*\)/g, ' ');
  const out: string[] = [];
  const add = (s: string): void => {
    const n = normalizeForLink(s);
    if (n && !out.includes(n)) out.push(n);
  };
  add(noParens.split(',')[0] ?? '');
  add(noParens);
  add(name);
  return out;
}

interface Ranked {
  entry: CollectionTitleEntry;
  tier: 0 | 1; // 0 = exact (preferred), 1 = contained
  titleLen: number;
}

/**
 * Resolve the best same-collection recipe an ingredient refers to, or null.
 * `index` MUST contain only the host recipe's collection.
 */
export function resolveIngredientLink(
  ingredientName: string,
  hostRecipeId: string,
  hostTitle: string,
  index: TitleIndex,
): LinkMatch | null {
  const rawNorm = normalizeForLink(ingredientName);
  if (rawNorm.length < 3 || DIGITS_ONLY.test(rawNorm)) return null;
  const hostNorm = normalizeForLink(hostTitle);

  const eligible = (e: CollectionTitleEntry, titleNorm: string): boolean =>
    e.recipeId !== hostRecipeId && titleNorm !== hostNorm && titleNorm.length >= 3;

  const found: Ranked[] = [];

  // Exact pass: first (most-cleaned) candidate that hits wins the exact tier.
  for (const cand of exactCandidates(ingredientName)) {
    const entries = index.get(cand);
    if (!entries) continue;
    let hit = false;
    for (const e of entries) {
      if (eligible(e, cand)) {
        found.push({ entry: e, tier: 0, titleLen: cand.length });
        hit = true;
      }
    }
    if (hit) break;
  }

  // Contained pass: any indexed title (≥2 words) that appears as a
  // whole-phrase substring of the ingredient name. The ≥2-word floor keeps
  // generic single words ("salt", "water") from matching by containment.
  const hay = ` ${rawNorm} `;
  for (const [titleNorm, entries] of index) {
    if (wordCount(titleNorm) < 2 || titleNorm.length < 3) continue;
    if (!hay.includes(` ${titleNorm} `)) continue;
    for (const e of entries) {
      if (eligible(e, titleNorm)) found.push({ entry: e, tier: 1, titleLen: titleNorm.length });
    }
  }

  if (found.length === 0) return null;

  // Rank: exact over contained, then real content over placeholder, then
  // the longer (more specific) title.
  found.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.entry.hasContent) - Number(a.entry.hasContent) ||
      b.titleLen - a.titleLen,
  );
  const best = found[0]!;

  // Genuine ambiguity — another match ties the top rank but points at a
  // different recipe. Don't guess.
  const tiedDifferent = found.some(
    (r) =>
      r.entry.recipeId !== best.entry.recipeId &&
      r.tier === best.tier &&
      r.entry.hasContent === best.entry.hasContent &&
      r.titleLen === best.titleLen,
  );
  if (tiedDifferent) return null;

  return { recipeId: best.entry.recipeId, isPlaceholder: !best.entry.hasContent };
}
