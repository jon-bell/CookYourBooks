// The search worker owns everything expensive about a semantic query: the
// gte-small pipeline AND the library's vector matrix.
//
// It used to own only the cosine loop, which left the two genuinely dominant
// costs on the main thread — a full re-read + re-decode of every embedding
// BLOB out of SQLite on *every* query, then a second copy to pack them flat,
// then a blocking model inference. Because the flat buffer was transferred to
// the worker (and so neutered), none of that work could be reused across
// queries; a 16k-recipe library re-copied ~25 MB per keystroke-query and
// re-ran inference on the UI thread.
//
// Now the matrix is hydrated once and stays here, and the query text is
// embedded here too. A query is a string in and at most `limit` recipe ids
// out — no per-query vector traffic in either direction.
//
// Protocol: every request carries an `id`, every response echoes it. See the
// `Req`/`Res` unions below.

import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from '@cookyourbooks/domain';
import { env, pipeline } from '@huggingface/transformers';

import type { SearchWorkerRequest as Req, SearchWorkerResponse as Res } from './searchProtocol.js';

type FeatureExtractor = (
  input: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

const scope = self as unknown as {
  postMessage: (m: Res, transfer?: Transferable[]) => void;
};

function post(m: Res, transfer?: Transferable[]): void {
  scope.postMessage(m, transfer);
}

// ---------- model ----------

let loadPromise: Promise<FeatureExtractor> | undefined;

function loadModel(): Promise<FeatureExtractor> {
  if (!loadPromise) {
    // gte-small quantized weights (~30 MB), cached by the library in Cache
    // Storage after the first load. EMBEDDING_MODEL_ID is the HF repo id; the
    // Edge Function runs the same model through the native Supabase.ai API.
    // Single-threaded WASM on purpose: ONNX threading needs COOP/COEP headers
    // that neither the Vite web build nor the Capacitor WKWebView shell serves,
    // so pinning it keeps behavior identical to the main-thread build this
    // replaces. Moving off the UI thread is the win, not extra cores.
    const wasmBackend = env.backends.onnx.wasm;
    if (wasmBackend) wasmBackend.numThreads = 1;
    loadPromise = pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: 'q8' }).then(
      (p) => p as unknown as FeatureExtractor,
      (err: unknown) => {
        // Let a later attempt retry rather than latching the failure forever.
        loadPromise = undefined;
        throw err;
      },
    );
  }
  return loadPromise;
}

/**
 * gte-small is symmetric: no query-instruction prefix (unlike bge/e5), so
 * queries and documents are embedded identically — keep it that way or the
 * two stop being comparable.
 */
async function embed(text: string): Promise<Float32Array> {
  const pipe = await loadModel();
  const out = await pipe(text, { pooling: 'mean', normalize: true });
  const arr = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
  if (arr.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedder returned ${arr.length} dims, expected ${EMBEDDING_DIM}. Model drift?`,
    );
  }
  return arr;
}

// ---------- vector matrix ----------

let ids: string[] = [];
let vectors: Float32Array<ArrayBufferLike> = new Float32Array(0);
let count = 0;

/**
 * Brute-force cosine over the hydrated matrix. Both sides are L2-normalized at
 * write time, so the dot product IS the cosine similarity.
 *
 * Inner loop unrolled by 4 — measurable on V8 for 384-dim vectors. The dim is
 * fixed, so the remainder is at most 3 floats.
 */
function scoreAll(queryVec: Float32Array): Float64Array {
  const dim = EMBEDDING_DIM;
  const out = new Float64Array(count);
  const limit = dim - (dim % 4);
  for (let i = 0; i < count; i += 1) {
    const base = i * dim;
    let dot = 0;
    let j = 0;
    for (; j < limit; j += 4) {
      dot +=
        vectors[base + j]! * queryVec[j]! +
        vectors[base + j + 1]! * queryVec[j + 1]! +
        vectors[base + j + 2]! * queryVec[j + 2]! +
        vectors[base + j + 3]! * queryVec[j + 3]!;
    }
    for (; j < dim; j += 1) {
      dot += vectors[base + j]! * queryVec[j]!;
    }
    out[i] = dot;
  }
  return out;
}

/** Top `limit` indices by score, descending. */
function topK(scores: Float64Array, limit: number): number[] {
  const order = new Array<number>(scores.length);
  for (let i = 0; i < scores.length; i += 1) order[i] = i;
  order.sort((a, b) => scores[b]! - scores[a]!);
  return order.slice(0, limit);
}

// ---------- dispatch ----------

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  void (async () => {
    try {
      switch (msg.type) {
        case 'load': {
          await loadModel();
          post({ type: 'loaded', id: msg.id });
          return;
        }
        case 'hydrate': {
          ids = msg.ids;
          vectors = msg.vectors;
          count = msg.count;
          post({ type: 'hydrated', id: msg.id, count });
          return;
        }
        case 'embed': {
          const vector = await embed(msg.text);
          // Copy out: the caller gets its own buffer and we keep none.
          post({ type: 'embedded', id: msg.id, vector }, [vector.buffer]);
          return;
        }
        case 'query': {
          const t0 = performance.now();
          const queryVec = await embed(msg.text);
          const t1 = performance.now();
          const scores = scoreAll(queryVec);
          const picked = topK(scores, msg.limit);
          const t2 = performance.now();
          post({
            type: 'result',
            id: msg.id,
            recipeIds: picked.map((i) => ids[i]!),
            scores: picked.map((i) => scores[i]!),
            scanned: count,
            embedMs: t1 - t0,
            scoreMs: t2 - t1,
          });
          return;
        }
      }
    } catch (err) {
      post({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};

// Stub export so `?worker` resolves a module.
export {};
