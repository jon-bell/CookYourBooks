import { collectionRepo } from '../data/repos.js';
import { listSearchableEmbeddings, type RecipeSearchHit } from '../local/repositories.js';
import { embedText } from './embedder.js';
// eslint-disable-next-line import/default -- Vite's `?worker` synthesizes the default export
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
// measured over a recipe corpus, true matches land ~0.85–0.91 while
// unrelated recipe/query pairs sit ~0.78–0.86 — the two overlap, so no
// floor cleanly separates "relevant" from "not". Ranking (sort by score,
// top-N) carries relevance; this FLOOR is a coarse tail-cut that drops
// genuinely off-topic results without amputating true matches near the
// bottom of the relevant band. 0.80 keeps the relevant band intact while
// trimming the lower tail. Tune downward if real matches feel missing.
const FLOOR = 0.8;

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
export async function searchSemantic(ownerId: string, q: string, limit = 50): Promise<SearchHit[]> {
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

  const out: SearchHit[] = [];
  for (let i = 0; i < scored.length && out.length < limit; i += 1) {
    const s = scored[i]!;
    if (s.score < FLOOR) break;
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

/** Literal fallback — used when the embedder is unavailable or the local
 *  vector cache is cold. Delegates to the repository's literal search, which
 *  also covers household-shared recipes and "not imported" placeholders. */
export async function searchSubstring(ownerId: string, q: string): Promise<SearchHit[]> {
  return collectionRepo(ownerId).searchRecipes(q);
}
