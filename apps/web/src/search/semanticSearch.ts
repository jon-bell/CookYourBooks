import { collectionRepo } from '../data/repos.js';
import { listSearchableEmbeddings, type RecipeSearchHit } from '../local/repositories.js';
import { embedText } from './embedder.js';
// eslint-disable-next-line import/default
import SearchWorker from './searchWorker.ts?worker';

/** A search result row. Same shape the literal search returns
 *  (`RecipeSearchHit`, incl. the `isPlaceholder` "not imported" flag) plus an
 *  optional cosine `score` for semantic hits. One shape so the page renders
 *  semantic + fallback results identically. */
export type SearchHit = RecipeSearchHit & {
  /** 0..1 cosine similarity for semantic hits, undefined for literal hits. */
  score?: number;
};

// gte-small dim. Hard-coded here too rather than imported from domain
// so the worker file can stay framework-free.
const DIM = 384;

// Calibrated for gte-small. Its cosine distribution is compressed and
// shifted high (very unlike bge's ~0.30–0.35 for unrelated text):
// measured over a *real* 16k-recipe library, a one-word query like
// "salad" scores max 0.92 / median 0.84 / min 0.80 across the WHOLE
// library — so a static 0.80 floor passed ~99.5% of recipes and the
// page returned the entire library lightly sorted. The bands also
// overlap (a real "Summer Barley Salad" at 0.871 sits *below* "Squash
// soup" at 0.883), so no fixed floor cleanly separates relevant from
// not. We use two cuts instead:
//   * ABS_FLOOR — a hard backstop that drops genuinely off-topic tail.
//   * RELATIVE_WINDOW — an adaptive cut anchored to the top hit: keep
//     only results within this much of the best score. This is what
//     actually tightens a compressed corpus from 200 hits down to the
//     handful clustered near the top, regardless of where the absolute
//     band happens to sit for a given query.
// The literal-first hybrid (see `searchHybrid`) is what guarantees the
// exact-term matches all surface and rank first; this adaptive cut just
// keeps the semantic *extras* below them from ballooning back into the
// whole library.
const ABS_FLOOR = 0.78;
const RELATIVE_WINDOW = 0.05;

/**
 * The effective score cutoff for a result set, given the top score.
 * Pure + exported so it can be unit-tested without the worker. Returns
 * the larger of the absolute backstop and "within RELATIVE_WINDOW of the
 * best hit" — so a high-scoring query (top 0.92) cuts at ~0.87 while a
 * weaker conceptual query (top 0.84) still keeps its own relevant band.
 */
export function adaptiveFloor(topScore: number): number {
  return Math.max(ABS_FLOOR, topScore - RELATIVE_WINDOW);
}

/**
 * Merge literal (exact-term) hits with semantic hits, literal first.
 * Pure + exported for unit testing. Literal matches keep their order and
 * always outrank semantic-only extras; semantic hits already present in
 * the literal set are dropped (deduped by recipeId). Capped at `limit`.
 */
export function mergeLiteralAndSemantic(
  literal: SearchHit[],
  semantic: SearchHit[],
  limit: number,
): SearchHit[] {
  const seen = new Set(literal.map((h) => h.recipeId));
  const out = literal.slice(0, limit);
  for (const h of semantic) {
    if (out.length >= limit) break;
    if (seen.has(h.recipeId)) continue;
    seen.add(h.recipeId);
    out.push(h);
  }
  return out;
}

// Singleton worker. Created lazily so /search-less sessions don't pay
// for the worker boot, and reused across queries to avoid re-create
// churn on every keystroke. Workers in Vite are module-scoped to the
// dev server / dist bundle.
let workerSingleton: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, (scores: number[]) => void>();

function getWorker(): Worker {
  if (!workerSingleton) {
    workerSingleton = new SearchWorker();
    workerSingleton.onmessage = (e: MessageEvent<{ id: number; scores: number[] }>) => {
      const resolve = pending.get(e.data.id);
      if (resolve) {
        pending.delete(e.data.id);
        resolve(e.data.scores);
      }
    };
  }
  return workerSingleton;
}

/**
 * Score every candidate against the query vector off-thread. Posts the
 * embeddings as a flat Float32Array (`count * dim` floats) so the
 * buffer transfers in O(1) instead of being structured-cloned per
 * vector — matters once the library is in the thousands of recipes.
 */
function scoreOffMainThread(
  queryVec: Float32Array,
  embeddings: Float32Array,
  count: number,
): Promise<number[]> {
  return new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, resolve);
    // The query vector is small (1.5 KB) — copy is fine. The flat
    // embeddings buffer is transferred so we don't pay the
    // structured-clone copy on the hot path.
    getWorker().postMessage({ id, queryVec, embeddings, count, dim: DIM }, [embeddings.buffer]);
  });
}

/**
 * Semantic search over the locally cached embeddings. Both sides are
 * L2-normalized at write time (recipe vectors via @huggingface/
 * transformers with `normalize: true`, query likewise), so the dot
 * product is the cosine similarity directly. The math runs in a Web
 * Worker so a 50k-recipe library doesn't stall the input box.
 */
export async function searchSemantic(
  ownerId: string,
  q: string,
  limit = 200,
): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const [queryVec, candidates] = await Promise.all([
    embedText(trimmed),
    listSearchableEmbeddings(ownerId),
  ]);
  if (candidates.length === 0) return [];

  // Pack candidate vectors into a single flat Float32Array so the
  // worker postMessage can transfer the buffer instead of copying N
  // separate typed arrays. Each candidate occupies `DIM` floats
  // starting at `idx * DIM`. The metadata stays on the main thread —
  // we map back by index after the worker returns scores.
  const flat = new Float32Array(candidates.length * DIM);
  for (let i = 0; i < candidates.length; i += 1) {
    flat.set(candidates[i]!.embedding, i * DIM);
  }

  const scores = await scoreOffMainThread(queryVec, flat, candidates.length);

  type Scored = { idx: number; score: number };
  const scored: Scored[] = new Array<Scored>(scores.length);
  for (let i = 0; i < scores.length; i += 1) {
    scored[i] = { idx: i, score: scores[i]! };
  }
  scored.sort((a, b) => b.score - a.score);

  // Adaptive cut anchored to the best hit, not a fixed floor — the
  // absolute cosine band drifts per query on gte-small, so "within
  // RELATIVE_WINDOW of the top" is what actually trims the tail.
  const floor = scored.length > 0 ? adaptiveFloor(scored[0]!.score) : ABS_FLOOR;

  const out: SearchHit[] = [];
  for (let i = 0; i < scored.length && out.length < limit; i += 1) {
    const s = scored[i]!;
    if (s.score < floor) break;
    const c = candidates[s.idx]!;
    out.push({
      recipeId: c.recipeId,
      recipeTitle: c.recipeTitle,
      collectionId: c.collectionId,
      collectionTitle: c.collectionTitle,
      sourceType: c.sourceType,
      isPlaceholder: c.isPlaceholder,
      score: s.score,
    });
  }
  return out;
}

/**
 * Hybrid search: exact-term (literal) matches first, then semantic
 * extras. For a word query like "salad" the literal pass deterministically
 * surfaces every recipe whose title or an ingredient contains the term —
 * ranked ahead of conceptually-related-but-not-a-salad results (soups,
 * dressings) that semantic alone would interleave. For a conceptual query
 * with no literal hits this degrades cleanly to pure semantic. Literal hits
 * also cover "not imported" placeholders and recipes with no embedding yet,
 * so nothing the literal search would have found is lost by going semantic.
 */
export async function searchHybrid(ownerId: string, q: string, limit = 200): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const [literal, semantic] = await Promise.all([
    collectionRepo(ownerId).searchRecipes(trimmed),
    searchSemantic(ownerId, trimmed, limit),
  ]);
  return mergeLiteralAndSemantic(literal, semantic, limit);
}

/** Literal fallback — used when the embedder is unavailable or the local
 *  vector cache is cold. Delegates to the repository's literal search, which
 *  also covers household-shared recipes and "not imported" placeholders. */
export async function searchSubstring(ownerId: string, q: string): Promise<SearchHit[]> {
  return collectionRepo(ownerId).searchRecipes(q);
}
