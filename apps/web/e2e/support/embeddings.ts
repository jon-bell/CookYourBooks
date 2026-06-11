import { expect } from '@playwright/test';

import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './env.js';
import { triggerWorker } from './imports.js';

// Helpers for the semantic-search e2e (edge-embed.spec.ts + semantic.spec.ts).
// Mirrors the service-role REST + expect.poll conventions in admin.ts /
// imports.ts. All writes go through PostgREST with the service-role key so
// the test can set up + inspect server state directly.

const adminHeaders = {
  apikey: SUPABASE_SERVICE_ROLE,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
  'Content-Type': 'application/json',
};

async function insert(table: string, rows: unknown[]): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...adminHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) throw new Error(`insert ${table}: ${resp.status} ${await resp.text()}`);
}

/**
 * Create a private collection + one recipe (+ optional ingredients) for the
 * given user via the service role. The recipe/ingredient INSERTs fire the
 * `recipes_enqueue_embed` / `ingredients_enqueue_embed` triggers, so a
 * PENDING `recipe_embedding_jobs` row is enqueued automatically — no manual
 * job insert needed. Pass `collectionId` to add several recipes to one
 * collection.
 */
export async function createUserRecipe(params: {
  ownerId: string;
  collectionTitle: string;
  recipeTitle: string;
  description?: string;
  ingredients?: string[];
  collectionId?: string;
}): Promise<{ collectionId: string; recipeId: string }> {
  const collectionId = params.collectionId ?? crypto.randomUUID();
  if (!params.collectionId) {
    await insert('recipe_collections', [
      {
        id: collectionId,
        owner_id: params.ownerId,
        title: params.collectionTitle,
        source_type: 'PERSONAL',
        is_public: false,
      },
    ]);
  }
  const recipeId = crypto.randomUUID();
  await insert('recipes', [
    {
      id: recipeId,
      collection_id: collectionId,
      title: params.recipeTitle,
      description: params.description ?? null,
      sort_order: 0,
    },
  ]);
  const ings = params.ingredients ?? [];
  if (ings.length > 0) {
    await insert(
      'ingredients',
      ings.map((name, j) => ({
        id: crypto.randomUUID(),
        recipe_id: recipeId,
        sort_order: j,
        type: 'MEASURED',
        name,
        quantity_type: 'EXACT',
        quantity_amount: 1,
        quantity_unit: 'piece',
      })),
    );
  }
  return { collectionId, recipeId };
}

export interface ServerEmbedding {
  embedding: number[];
  model: string;
  textHash: string;
}

// pgvector comes back over PostgREST as a JSON-array string "[...]" (or, on
// some deployments, an actual array). Tolerate both — mirrors decodeVector
// in apps/web/src/local/sync.ts.
function decodeVector(raw: number[] | string): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  return JSON.parse(raw) as number[];
}

export async function fetchServerEmbedding(recipeId: string): Promise<ServerEmbedding | null> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/recipe_embeddings?recipe_id=eq.${recipeId}&select=embedding,model,text_hash`,
    { headers: adminHeaders },
  );
  if (!resp.ok) throw new Error(`fetchServerEmbedding: ${resp.status} ${await resp.text()}`);
  const rows = (await resp.json()) as {
    embedding: number[] | string;
    model: string;
    text_hash: string;
  }[];
  const row = rows[0];
  if (!row) return null;
  return { embedding: decodeVector(row.embedding), model: row.model, textHash: row.text_hash };
}

export interface EmbedJobRow {
  status: string;
  attempts: number;
  last_error: string | null;
}

export async function fetchEmbedJob(recipeId: string): Promise<EmbedJobRow | null> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/recipe_embedding_jobs?recipe_id=eq.${recipeId}` +
      `&select=status,attempts,last_error&order=created_at.desc&limit=1`,
    { headers: adminHeaders },
  );
  if (!resp.ok) throw new Error(`fetchEmbedJob: ${resp.status} ${await resp.text()}`);
  const rows = (await resp.json()) as EmbedJobRow[];
  return rows[0] ?? null;
}

/**
 * Drive the edge worker until a 384-d vector exists for `recipeId`. Re-kicks
 * the worker between polls (the local stack has no cron vault secret, so the
 * test owns the cadence). The first kick pays the model cold-start (~5–10s);
 * one kick drains all PENDING jobs (CLAIM_BATCH=8), so sibling recipes are
 * usually embedded by the time their own wait runs.
 */
export async function waitForEmbedding(
  recipeId: string,
  opts: { timeoutMs?: number } = {},
): Promise<ServerEmbedding> {
  const timeout = opts.timeoutMs ?? 60_000;
  let last: ServerEmbedding | null = null;
  await expect
    .poll(
      async () => {
        await triggerWorker(null).catch(() => {
          // transient: a single failed kick shouldn't abort the poll
        });
        last = await fetchServerEmbedding(recipeId);
        return last?.embedding.length ?? 0;
      },
      { timeout, intervals: [1000, 2000, 3000] },
    )
    .toBe(384);
  return last!;
}

/** Sign in via the GoTrue password grant and return the access token, so a
 *  test can hit PostgREST AS that user (RLS enforced, unlike the service
 *  role which bypasses it). */
export async function userAccessToken(email: string, password: string): Promise<string> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) throw new Error(`userAccessToken: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as { access_token: string }).access_token;
}

/** How many recipe_embeddings rows this user's JWT can read for a recipe
 *  (RLS-filtered). 0 = not visible, 1 = visible. */
export async function userCanReadEmbedding(token: string, recipeId: string): Promise<number> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/recipe_embeddings?recipe_id=eq.${recipeId}&select=recipe_id`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) throw new Error(`userCanReadEmbedding: ${resp.status} ${await resp.text()}`);
  return ((await resp.json()) as unknown[]).length;
}

/** Cosine similarity. Vectors are L2-normalized at write time, so this is
 *  effectively the dot product, but compute the full form defensively. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
