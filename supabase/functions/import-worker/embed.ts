// Recipe embedding pipeline (worker side).
//
// Same model + tokenizer + dimensions as the browser path. Loaded once
// per cold start of the Edge Function; subsequent invocations of the
// same instance reuse the cached pipeline.
//
// The deno bundle of @huggingface/transformers ships ONNX Runtime Web
// alongside; weight downloads are cached in the function's
// `/tmp/transformers-cache` directory for the lifetime of the instance.

import { pipeline } from 'https://esm.sh/@huggingface/transformers@3.7.4';

// Pinned identifiers. Keep in lockstep with
// packages/domain/src/services/embeddingModel.ts — bumping either
// requires re-embedding the whole corpus.
export const EMBEDDING_MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const EMBEDDING_DIM = 384;

type FeatureExtractor = (
  input: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

let pipePromise: Promise<FeatureExtractor> | undefined;

export function preloadEmbedder(): Promise<FeatureExtractor> {
  if (!pipePromise) {
    pipePromise = (async () => {
      const p = await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
        dtype: 'q8',
      });
      return p as unknown as FeatureExtractor;
    })();
  }
  return pipePromise;
}

export async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await preloadEmbedder();
  const out: Float32Array[] = [];
  // Process serially. Library batches internally when given an array,
  // but its return shape concatenates into a (N*dim) flat buffer that
  // we'd have to chunk back apart. A small per-job loop is plenty fast
  // for the queue rate we expect (single-digit batches per cron tick).
  for (const text of texts) {
    const res = await pipe(text, { pooling: 'mean', normalize: true });
    const arr = res.data instanceof Float32Array
      ? new Float32Array(res.data)
      : Float32Array.from(res.data);
    if (arr.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedder returned ${arr.length} dims, expected ${EMBEDDING_DIM}.`,
      );
    }
    out.push(arr);
  }
  return out;
}

// ----- recipe → embed text helper (mirror of buildRecipeEmbedText) -----
//
// Inlined rather than pulled from @cookyourbooks/domain so the Deno
// bundle stays self-contained (no workspace path resolution needed
// inside the Edge Function deploy artifact). MUST stay in lockstep
// with packages/domain/src/services/embeddingModel.ts so the SHA-256
// hashes computed on both sides agree.

export interface EmbedRecipeInput {
  title: string;
  description: string | null;
  notes: string | null;
  book_title: string | null;
  equipment: string[] | null;
  ingredients: ReadonlyArray<{
    name: string;
    preparation: string | null;
    type: string;
    description: string | null;
  }>;
}

export function buildRecipeEmbedText(r: EmbedRecipeInput): string {
  const parts: string[] = [];
  parts.push(`Title: ${r.title.trim()}`);
  if (r.book_title && r.book_title.trim()) parts.push(`Cookbook: ${r.book_title.trim()}`);
  if (r.description && r.description.trim()) parts.push(`Description: ${r.description.trim()}`);
  if (r.equipment && r.equipment.length > 0) {
    const eq = r.equipment.map((e) => e.trim()).filter(Boolean);
    if (eq.length > 0) parts.push(`Equipment: ${eq.join(', ')}`);
  }
  const ingLines: string[] = [];
  for (const ing of r.ingredients) {
    const name = ing.name.trim();
    if (!name) continue;
    let line = name;
    if (ing.preparation && ing.preparation.trim()) line += ` (${ing.preparation.trim()})`;
    if (ing.type === 'VAGUE' && ing.description && ing.description.trim()) {
      line += ` — ${ing.description.trim()}`;
    }
    ingLines.push(line);
  }
  if (ingLines.length > 0) parts.push(`Ingredients: ${ingLines.join('; ')}`);
  if (r.notes && r.notes.trim()) parts.push(`Notes: ${r.notes.trim()}`);
  return parts.join('\n');
}

export async function hashEmbedText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i += 1) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}
