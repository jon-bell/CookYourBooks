import { listSearchableEmbeddings, searchRecipesLocalSubstring } from '../local/repositories.js';
import { embedText } from './embedder.js';

export interface SearchHit {
  recipeId: string;
  collectionId: string;
  collectionTitle: string;
  collectionSourceType: string;
  title: string;
  /** 0..1 cosine similarity for semantic hits, undefined for substring hits. */
  score?: number;
}

/**
 * Brute-force cosine search in JS over the locally cached vectors.
 *
 * Both sides are L2-normalized at write time (recipe vectors come from
 * @huggingface/transformers with `normalize: true`, query vectors
 * likewise), so the dot product *is* the cosine similarity. Math
 * fits in <10 ms for libraries up to a few thousand recipes; no need
 * for ANN structures locally.
 */
export async function searchSemantic(
  ownerId: string,
  q: string,
  limit = 50,
): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const [queryVec, candidates] = await Promise.all([
    embedText(trimmed),
    listSearchableEmbeddings(ownerId),
  ]);
  if (candidates.length === 0) return [];

  type Scored = { idx: number; score: number };
  const scored: Scored[] = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i += 1) {
    const vec = candidates[i]!.embedding;
    let dot = 0;
    for (let j = 0; j < vec.length; j += 1) {
      dot += vec[j]! * queryVec[j]!;
    }
    scored[i] = { idx: i, score: dot };
  }
  scored.sort((a, b) => b.score - a.score);

  const out: SearchHit[] = [];
  // BGE cosine on totally-unrelated text lands around 0.30–0.35; ramen
  // versus "ramen" is closer to 0.85. A modest floor keeps the tail of
  // 5000-recipe libraries from drowning real matches with off-topic
  // noise. Tune downward if real matches feel missing.
  const FLOOR = 0.35;
  for (let i = 0; i < scored.length && out.length < limit; i += 1) {
    const s = scored[i]!;
    if (s.score < FLOOR) break;
    const c = candidates[s.idx]!;
    out.push({
      recipeId: c.recipeId,
      collectionId: c.collectionId,
      collectionTitle: c.collectionTitle,
      collectionSourceType: c.collectionSourceType,
      title: c.title,
      score: s.score,
    });
  }
  return out;
}

/** Substring fallback shim — exposed alongside semantic so callers can
 *  swap in one place. Returns hits in the same shape. */
export async function searchSubstring(
  ownerId: string,
  q: string,
  limit = 50,
): Promise<SearchHit[]> {
  const rows = await searchRecipesLocalSubstring(ownerId, q, limit);
  return rows.map((r) => ({ ...r }));
}
