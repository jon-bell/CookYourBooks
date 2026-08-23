import { collectionRepo } from '../data/repos.js';
import { listSearchHitsByIds, type RecipeSearchHit } from '../local/repositories.js';
import { createSearchTimer, nullSearchTimer, type SearchTimer } from './perf.js';
import { queryVectors } from './workerClient.js';

/** A search result row. Same shape the literal search returns
 *  (`RecipeSearchHit`, incl. the `isPlaceholder` "not imported" flag) plus an
 *  optional cosine `score` for semantic hits. One shape so the page renders
 *  semantic + fallback results identically. */
export type SearchHit = RecipeSearchHit & {
  /** 0..1 cosine similarity for semantic hits, undefined for literal hits. */
  score?: number;
};

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
/** Most results the page will render. Both search paths cap here. */
export const SEARCH_LIMIT = 200;

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

/**
 * Semantic search over the library's vectors. Both sides are L2-normalized at
 * write time (recipe vectors via @huggingface/transformers with
 * `normalize: true`, query likewise), so the dot product is the cosine
 * similarity directly.
 *
 * The model and the vector matrix both live in the worker, so this is a string
 * out and at most `limit` recipe ids back — no vector ever crosses onto the
 * main thread. Result metadata is then read for just those ids, which keeps
 * titles fresh without scanning the library.
 */
export async function searchSemantic(
  ownerId: string,
  q: string,
  limit = 200,
  timer: SearchTimer = nullSearchTimer(),
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];

  const result = await timer.track('vectorQuery', () =>
    queryVectors(ownerId, trimmed, limit, signal),
  );
  // The worker measures these two itself; surface them as first-class stages.
  timer.mark('embed', result.embedMs);
  timer.mark('cosine', result.scoreMs);
  timer.vectors(result.scanned);
  if (result.recipeIds.length === 0) return [];

  // Adaptive cut anchored to the best hit, not a fixed floor — the absolute
  // cosine band drifts per query on gte-small, so "within RELATIVE_WINDOW of
  // the top" is what actually trims the tail. The worker already sorted
  // descending, so this is a prefix.
  const floor = adaptiveFloor(result.scores[0]!);
  const keptIds: string[] = [];
  const keptScores: number[] = [];
  for (let i = 0; i < result.recipeIds.length; i += 1) {
    if (result.scores[i]! < floor) break;
    keptIds.push(result.recipeIds[i]!);
    keptScores.push(result.scores[i]!);
  }
  if (keptIds.length === 0) return [];

  const meta = await timer.track('metadata', () => listSearchHitsByIds(ownerId, keptIds));
  const byId = new Map(meta.map((m) => [m.recipeId, m]));

  const out: SearchHit[] = [];
  for (let i = 0; i < keptIds.length; i += 1) {
    const hit = byId.get(keptIds[i]!);
    // Absent means deleted or un-shared since the matrix was hydrated — the
    // metadata query re-applies visibility, so dropping it here is the fix.
    if (!hit) continue;
    out.push({ ...hit, score: keptScores[i]! });
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
export async function searchHybrid(
  ownerId: string,
  q: string,
  limit = SEARCH_LIMIT,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const timer = createSearchTimer(trimmed);
  const [literal, semantic] = await Promise.all([
    // Capped at `limit` because mergeLiteralAndSemantic slices to it anyway —
    // fetching more rows only pays marshaling for results nobody can see.
    timer.track('literal', () => collectionRepo(ownerId).searchRecipes(trimmed, limit)),
    searchSemantic(ownerId, trimmed, limit, timer, signal),
  ]);
  const merged = timer.sync('merge', () => mergeLiteralAndSemantic(literal, semantic, limit));
  timer.finish({ mode: 'semantic', hits: merged.length });
  return merged;
}

/** Literal fallback — used when the embedder is unavailable or the local
 *  vector cache is cold. Delegates to the repository's literal search, which
 *  also covers household-shared recipes and "not imported" placeholders.
 *
 *  Fetches one row past `limit` so the caller can tell "exactly this many" from
 *  "at least this many" without paying for a second COUNT query. */
export async function searchSubstring(
  ownerId: string,
  q: string,
  limit = 200,
): Promise<SearchHit[]> {
  const timer = createSearchTimer(q.trim());
  const hits = await timer.track('literal', () =>
    collectionRepo(ownerId).searchRecipes(q, limit + 1),
  );
  timer.finish({ mode: 'substring', hits: hits.length });
  return hits;
}
