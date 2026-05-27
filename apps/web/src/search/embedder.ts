import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from '@cookyourbooks/domain';

// Lazy-loaded singleton wrapper around @huggingface/transformers.
//
// The first call has to download ~30 MB of weights (ONNX + tokenizer)
// the first time per device. The library caches them in Cache Storage
// automatically. Subsequent loads are ~150 ms warmup, then ~50–200 ms
// per query embedding on M-series hardware.
//
// We expose three states so the UI can show a "preparing semantic
// search" hint without blocking the whole page:
//   * 'idle'        — no one has tried to load it yet
//   * 'loading'     — weights are downloading / pipeline initializing
//   * 'ready'       — `embedText` is fast and ready
//   * 'unavailable' — the runtime refused to initialize (e.g. very old
//                     browser without WebAssembly). The search page
//                     falls back to substring matches.

export type EmbedderStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

type FeatureExtractor = (
  input: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

let pipelinePromise: Promise<FeatureExtractor> | undefined;
let status: EmbedderStatus = 'idle';
const listeners = new Set<(s: EmbedderStatus) => void>();

function setStatus(next: EmbedderStatus): void {
  if (status === next) return;
  status = next;
  for (const l of listeners) {
    try {
      l(next);
    } catch {
      // A misbehaving listener mustn't break the others.
    }
  }
}

export function getEmbedderStatus(): EmbedderStatus {
  return status;
}

export function subscribeEmbedderStatus(
  fn: (s: EmbedderStatus) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Test hatch — when set before the embedder is touched, the runtime
 * refuses to load and the search page falls back to substring search.
 * Used by Playwright to keep CI off the model CDN.
 */
function isEmbedderDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as unknown as { __cybDisableEmbedder?: boolean }).__cybDisableEmbedder;
}

/**
 * Kick off the embedder load. Safe to call repeatedly; the first call
 * wins and subsequent callers wait on the same promise.
 */
export function preloadEmbedder(): Promise<FeatureExtractor> {
  if (isEmbedderDisabled()) {
    setStatus('unavailable');
    return Promise.reject(new Error('embedder disabled (test shim)'));
  }
  if (!pipelinePromise) {
    setStatus('loading');
    pipelinePromise = loadPipeline().then(
      (p) => {
        setStatus('ready');
        return p;
      },
      (err) => {
        setStatus('unavailable');
        pipelinePromise = undefined;
        throw err;
      },
    );
  }
  return pipelinePromise;
}

async function loadPipeline(): Promise<FeatureExtractor> {
  // Dynamic import keeps the ~MB-sized library out of the initial
  // bundle — only fetched when the user actually visits /search.
  const transformers = await import('@huggingface/transformers');
  // Quantized weights are the small ones (~33 MB) — fine for the
  // browser. The library auto-picks WebGPU when present and falls
  // back to WASM otherwise.
  const extractor = await transformers.pipeline(
    'feature-extraction',
    EMBEDDING_MODEL_ID,
    { dtype: 'q8' },
  );
  return extractor as unknown as FeatureExtractor;
}

/**
 * Embed a single text string. Returns a normalized Float32Array
 * of EMBEDDING_DIM floats — both the recipe vectors and the query
 * vector come from this same call, so the dot product is the cosine
 * similarity directly.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const pipe = await preloadEmbedder();
  const out = await pipe(text, { pooling: 'mean', normalize: true });
  const arr = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
  if (arr.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedder returned ${arr.length} dims, expected ${EMBEDDING_DIM}. Model drift?`,
    );
  }
  return arr;
}
