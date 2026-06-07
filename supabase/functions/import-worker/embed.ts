// Recipe embedding pipeline (worker side).
//
// Runs gte-small through the Supabase Edge Runtime's native AI inference
// API (`Supabase.ai.Session`). transformers.js does NOT work in this
// runtime — its ONNX backend exposes no execution provider, so
// `pipeline('feature-extraction', …)` throws `Unsupported device: "cpu"`.
// The native session is the Supabase-supported path: fast (sub-second
// warm, ~5s cold incl. model load), no request-time CDN download, and
// 384-d. gte-small is symmetric (no query-instruction prefix), matching
// the browser's Xenova/gte-small so the vectors are cosine-comparable.

// Logical stored-model id. Keep in lockstep with
// packages/domain/src/services/embeddingModel.ts (EMBEDDING_STORED_MODEL):
// this is the value written to recipe_embeddings.model and compared for
// cache hits on both browser and edge. Bumping it requires re-embedding
// the whole corpus.
export const EMBEDDING_STORED_MODEL = 'gte-small';
export const EMBEDDING_DIM = 384;

// The native session's bundled model name. Conceptually distinct from
// EMBEDDING_STORED_MODEL (the loader id vs the stored id) even though
// they share a string today.
const GTE_SESSION_MODEL = 'gte-small';

// `Supabase` is an ambient global injected by the Edge Runtime. Declare
// it so the Deno LSP / `deno check` are clean (edge functions are not in
// the pnpm typecheck gate). With `mean_pool: true` the session returns a
// single mean-pooled vector as a plain number[] — NOT a transformers.js
// `{ data }` tensor.
type AiSession = {
  run(
    input: string,
    opts?: { mean_pool?: boolean; normalize?: boolean },
  ): Promise<number[] | Float32Array>;
};
declare const Supabase: { ai: { Session: new (model: string) => AiSession } };

// One session per warm instance. Constructed lazily — if the runtime
// lacks the model the constructor throws here, which surfaces through
// embedBatch to the per-job retry budget in index.ts (no infinite loop).
let sessionSingleton: AiSession | undefined;
function getSession(): AiSession {
  if (!sessionSingleton) {
    sessionSingleton = new Supabase.ai.Session(GTE_SESSION_MODEL);
  }
  return sessionSingleton;
}

export async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const session = getSession();
  const out: Float32Array[] = [];
  // Process serially — single-digit batches per tick, so the simple loop
  // is plenty fast. mean_pool + normalize yield one L2-normalized 384-d
  // vector per text (dot product = cosine).
  for (const text of texts) {
    const res = await session.run(text, { mean_pool: true, normalize: true });
    const arr = res instanceof Float32Array ? res : Float32Array.from(res as ArrayLike<number>);
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
