// Pure duplicate-recipe detection for the collection "table of contents"
// self-heal. Photographing a bilingual cookbook's contents page tends to mint
// TWO empty placeholder recipes per dish (one per language ordering — e.g.
// "RUOTA DEL FARAONE Pharaoh's Wheel" AND "Pharaoh's wheel (Ruota del
// Faraone)"), and a later bulk scan then creates the *filled* recipe in a third
// title format that never matched the placeholders — so a ~150-recipe book ends
// up with 350+ rows. This finds those clusters so the UI can offer to merge
// them down (preview-first; it never deletes on its own).
//
// Matching is TOKEN-SET based, not character-based (scoreTocMatch): the three
// title variants share the same words in different orders, which levenshtein
// scores poorly but a word-set overlap nails. `page_numbers[0]` is the bucket
// key — reliable here — but a page can hold several *distinct* recipes (three
// broths + a soup all on one page), so titles disambiguate within a page.

export interface DedupRecipe {
  id: string;
  title: string;
  /** First source page number (recipes.page_numbers[0]), or null if unknown. */
  firstPage: number | null;
  /** True for a real recipe; false for an empty ToC placeholder. */
  hasContent: boolean;
  /** Ingredient + instruction count — the survivor tiebreak (most complete wins). */
  completeness: number;
}

export interface DedupCluster {
  /** The recipe to keep. */
  survivor: DedupRecipe;
  /** Redundant recipes to remove (always ≥ 1). */
  duplicates: DedupRecipe[];
}

/** Merge two titles when their word-set similarity reaches this. */
const MERGE_THRESHOLD = 0.6;

// English + Italian articles/prepositions that add noise without identity.
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'or',
  'of',
  'the',
  'with',
  'in',
  'on',
  'to',
  'for',
  'from',
  'by',
  'two',
  'di',
  'e',
  'con',
  'al',
  'alla',
  'alle',
  'allo',
  'ai',
  'agli',
  'la',
  'le',
  'lo',
  'il',
  'i',
  'gli',
  'un',
  'una',
  'uno',
  'per',
  'da',
  'del',
  'della',
  'delle',
  'dei',
  'degli',
  'dal',
]);

/** Meaningful lowercased word set of a title (punctuation, stopwords, and
 *  single characters stripped). Exported for the contract test. */
export function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const t of title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)) {
    if (t.length <= 1 || STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Word-set similarity in [0,1]. Jaccard, plus a subset bonus: when every
 *  meaningful word of the shorter title appears in the longer one (≥ 2 words),
 *  they're almost certainly the same dish stated in one vs. two languages. */
export function titleSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  if (inter === 0) return 0;
  const jaccard = inter / (a.size + b.size - inter);
  const minSize = Math.min(a.size, b.size);
  const subset = minSize >= 2 && inter === minSize ? 0.95 : 0;
  return Math.max(jaccard, subset);
}

/** Keep the richest row: real content first, then most complete, then the
 *  longest (usually most complete) title, then a stable id order. */
function compareSurvivor(a: DedupRecipe, b: DedupRecipe): number {
  if (a.hasContent !== b.hasContent) return a.hasContent ? -1 : 1;
  if (a.completeness !== b.completeness) return b.completeness - a.completeness;
  const at = a.title.trim().length;
  const bt = b.title.trim().length;
  if (at !== bt) return bt - at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Cluster likely-duplicate recipes. Buckets by first page number, then single-
 * link agglomerates within a bucket by title similarity. Rows without a page
 * number are left untouched (too little signal — usually section headers).
 * Returns one entry per cluster of ≥ 2, with the survivor chosen and the rest
 * marked for removal.
 */
export function findDuplicateClusters(recipes: readonly DedupRecipe[]): DedupCluster[] {
  const byPage = new Map<number, DedupRecipe[]>();
  for (const r of recipes) {
    if (r.firstPage == null) continue;
    const arr = byPage.get(r.firstPage);
    if (arr) arr.push(r);
    else byPage.set(r.firstPage, [r]);
  }

  const clusters: DedupCluster[] = [];
  for (const bucket of byPage.values()) {
    if (bucket.length < 2) continue;

    // Single-link agglomerative clustering: a row joins an existing group if it
    // matches ANY member (transitive), else starts its own.
    const groups: DedupRecipe[][] = [];
    const groupTokens: Set<string>[][] = [];
    for (const r of bucket) {
      const tok = titleTokens(r.title);
      let placed = false;
      for (let g = 0; g < groups.length; g += 1) {
        if (groupTokens[g]!.some((t) => titleSimilarity(tok, t) >= MERGE_THRESHOLD)) {
          groups[g]!.push(r);
          groupTokens[g]!.push(tok);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push([r]);
        groupTokens.push([tok]);
      }
    }

    for (const g of groups) {
      if (g.length < 2) continue;
      const [survivor, ...duplicates] = [...g].sort(compareSurvivor);
      clusters.push({ survivor: survivor!, duplicates });
    }
  }
  return clusters;
}

/** Total rows that would be removed across all clusters. */
export function countDuplicates(clusters: readonly DedupCluster[]): number {
  return clusters.reduce((n, c) => n + c.duplicates.length, 0);
}
