// Main-thread half of the search worker.
//
// Owns the Worker singleton, correlates requests with responses, tracks the
// model's load status for the UI, and keeps the worker's vector matrix in
// sync with the local mirror.
//
// The model and the matrix both live in the worker, so this module never
// touches a vector on the hot path — a query is a string out and a short list
// of recipe ids back.

import { getEmbeddingVersion, listEmbeddingVectors } from '../local/repositories.js';
import type { SearchWorkerRequest, SearchWorkerResponse } from './searchProtocol.js';
// eslint-disable-next-line import/default
import SearchWorker from './searchWorker.ts?worker';

export type EmbedderStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

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

export function subscribeEmbedderStatus(fn: (s: EmbedderStatus) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Test hatch — when set before the worker is touched, we refuse to spawn it
 * and the search page falls back to substring search. Keeps Playwright off the
 * model CDN. Checked here rather than in the worker because the worker has no
 * `window`.
 */
function isEmbedderDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as unknown as { __cybDisableEmbedder?: boolean }).__cybDisableEmbedder;
}

// ---------- worker plumbing ----------

interface Pending {
  resolve: (r: SearchWorkerResponse) => void;
  reject: (e: Error) => void;
}

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function getWorker(): Worker {
  if (!worker) {
    worker = new SearchWorker();
    worker.onmessage = (e: MessageEvent<SearchWorkerResponse>) => {
      const res = e.data;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.type === 'error') p.reject(new Error(res.message));
      else p.resolve(res);
    };
    worker.onerror = () => {
      // A worker-level error (bad bundle, OOM) is not recoverable per-request.
      setStatus('unavailable');
      failAll(new Error('search worker crashed'));
      hydratedVersion = undefined;
    };
  }
  return worker;
}

function request(
  msg: SearchWorkerRequest,
  transfer?: Transferable[],
): Promise<SearchWorkerResponse> {
  return new Promise<SearchWorkerResponse>((resolve, reject) => {
    pending.set(msg.id, { resolve, reject });
    if (transfer) getWorker().postMessage(msg, transfer);
    else getWorker().postMessage(msg);
  });
}

// ---------- model ----------

let loadPromise: Promise<void> | undefined;

/**
 * Kick off the model load in the worker. Safe to call repeatedly; the first
 * call wins and later callers await the same promise.
 */
export function preloadEmbedder(): Promise<void> {
  if (isEmbedderDisabled()) {
    setStatus('unavailable');
    return Promise.reject(new Error('embedder disabled (test shim)'));
  }
  if (!loadPromise) {
    setStatus('loading');
    loadPromise = request({ type: 'load', id: nextId++ }).then(
      () => {
        setStatus('ready');
      },
      (err: unknown) => {
        setStatus('unavailable');
        loadPromise = undefined;
        throw err;
      },
    );
  }
  return loadPromise;
}

/**
 * Embed one string. Used by the recipe save path; the search path never needs
 * the raw vector on the main thread because scoring happens in the worker.
 */
export async function embedText(text: string): Promise<Float32Array> {
  await preloadEmbedder();
  const res = await request({ type: 'embed', id: nextId++, text });
  if (res.type !== 'embedded') throw new Error(`unexpected response ${res.type}`);
  return res.vector;
}

// ---------- vector matrix ----------

let hydratedVersion: number | undefined;
let hydratedOwner: string | undefined;
let hydrating: Promise<void> | undefined;

/** Force a re-hydrate on the next query. Exposed for tests. */
export function invalidateVectorMatrix(): void {
  hydratedVersion = undefined;
}

/**
 * Make sure the worker's matrix matches the local mirror. Re-hydrates wholesale
 * whenever an embedding write bumped the version (or the user changed) — a
 * correct-but-occasionally-redundant full refresh, rather than incremental
 * patching that could leave a stale vector in place.
 */
async function ensureHydrated(ownerId: string): Promise<number> {
  const version = getEmbeddingVersion();
  if (hydratedVersion === version && hydratedOwner === ownerId) return version;
  // Collapse concurrent callers onto one hydration.
  hydrating ??= (async () => {
    const { ids, vectors } = await listEmbeddingVectors(ownerId);
    await request(
      { type: 'hydrate', id: nextId++, ids, vectors, count: ids.length },
      // Transfer, don't copy: this is the one time the vectors cross the
      // boundary, and the main thread has no further use for them.
      [vectors.buffer],
    );
    hydratedVersion = version;
    hydratedOwner = ownerId;
  })().finally(() => {
    hydrating = undefined;
  });
  await hydrating;
  return version;
}

function abortError(): Error {
  // DOMException('AbortError') is what React Query recognises as a cancel
  // rather than a failure, so a superseded query doesn't surface as an error.
  return typeof DOMException !== 'undefined'
    ? new DOMException('search aborted', 'AbortError')
    : Object.assign(new Error('search aborted'), { name: 'AbortError' });
}

export interface VectorQueryResult {
  recipeIds: string[];
  scores: number[];
  scanned: number;
  embedMs: number;
  scoreMs: number;
}

/**
 * Embed `text` and return the top `limit` recipe ids by cosine, hydrating the
 * worker's matrix first if the local mirror has moved.
 */
export async function queryVectors(
  ownerId: string,
  text: string,
  limit: number,
  signal?: AbortSignal,
): Promise<VectorQueryResult> {
  // The worker handles one request at a time, so a query the user has already
  // typed past would still hold the queue. Bail at each await boundary — the
  // checks are what keep a burst of keystrokes from serialising behind itself.
  if (signal?.aborted) throw abortError();
  await preloadEmbedder();
  if (signal?.aborted) throw abortError();
  await ensureHydrated(ownerId);
  if (signal?.aborted) throw abortError();
  const res = await request({ type: 'query', id: nextId++, text, limit });
  if (res.type !== 'result') throw new Error(`unexpected response ${res.type}`);
  return {
    recipeIds: res.recipeIds,
    scores: res.scores,
    scanned: res.scanned,
    embedMs: res.embedMs,
    scoreMs: res.scoreMs,
  };
}
