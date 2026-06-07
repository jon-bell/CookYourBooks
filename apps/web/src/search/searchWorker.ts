// Web Worker for the brute-force cosine pass.
//
// Lives off the main thread because a library with thousands of
// embeddings would otherwise stall input on /search while the loop
// runs (a single query is O(N · 384) multiplies, easily 10–50 ms at
// N=10k on mid-range hardware; growing linearly past that).
//
// Protocol: main thread posts a single message of shape
//   { id, queryVec, embeddings, count, dim }
// and gets back one of shape `{ id, scores }`. `embeddings` is a flat
// Float32Array of `count * dim` floats so the buffer can transfer
// without a structured-clone copy; the main thread reattaches metadata
// by index on the way out.

interface WorkerRequest {
  id: number;
  queryVec: Float32Array;
  embeddings: Float32Array;
  count: number;
  dim: number;
}

interface WorkerResponse {
  id: number;
  /** Plain number[] so the main thread can read it without juggling buffers. */
  scores: number[];
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, queryVec, embeddings, count, dim } = e.data;
  if (queryVec.length !== dim) {
    (self as unknown as { postMessage: (m: WorkerResponse) => void }).postMessage({
      id,
      scores: [],
    });
    return;
  }
  const scores = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    const base = i * dim;
    let dot = 0;
    // Inner-loop unrolled by 4 — measurable boost on V8 for 384-dim
    // vectors. The dim is fixed (BGE-small) so the remainder is at
    // most 3 floats; handle them after.
    let j = 0;
    const limit = dim - (dim % 4);
    for (; j < limit; j += 4) {
      dot +=
        embeddings[base + j]! * queryVec[j]! +
        embeddings[base + j + 1]! * queryVec[j + 1]! +
        embeddings[base + j + 2]! * queryVec[j + 2]! +
        embeddings[base + j + 3]! * queryVec[j + 3]!;
    }
    for (; j < dim; j += 1) {
      dot += embeddings[base + j]! * queryVec[j]!;
    }
    scores[i] = dot;
  }
  (self as unknown as { postMessage: (m: WorkerResponse) => void }).postMessage({
    id,
    scores,
  });
};

// Stub export so `?worker` resolves a module.
export {};
