import {
  buildRecipeEmbedText,
  EMBEDDING_MODEL_ID,
  hashEmbedText,
  type Recipe,
} from '@cookyourbooks/domain';
import { getLocalEmbedding, upsertLocalEmbedding } from '../local/repositories.js';
import { enqueue } from '../local/outbox.js';
import { embedText, getEmbedderStatus, preloadEmbedder } from './embedder.js';

/**
 * Compute and persist a recipe's embedding locally, then enqueue an
 * outbox push so the canonical pgvector row catches up on the next
 * sync drain. Skips work when the recipe text hash + model haven't
 * changed since the last cached vector.
 *
 * Designed to run after the recipe save completes — the caller should
 * NOT await this (it lazily downloads ~30 MB of weights the first time
 * the user creates a recipe in a fresh browser, and we don't want to
 * block the save UI on that).
 */
export async function embedAndPushRecipe(recipe: Recipe): Promise<void> {
  // Skip when the model isn't even loadable — we'll degrade to
  // substring search and the worker will fill the canonical vector
  // server-side anyway.
  if (getEmbedderStatus() === 'unavailable') return;

  const text = buildRecipeEmbedText(recipe);
  const textHash = await hashEmbedText(text);
  const cached = await getLocalEmbedding(recipe.id);
  if (cached && cached.textHash === textHash && cached.model === EMBEDDING_MODEL_ID) {
    // No-op: the recipe's searchable text hasn't moved.
    return;
  }
  try {
    await preloadEmbedder();
  } catch {
    // Embedder load failed (status now 'unavailable'). The worker will
    // generate the canonical vector and we'll pull it back during the
    // next sync — give up on the local-first short-circuit.
    return;
  }
  const vector = await embedText(text);
  await upsertLocalEmbedding({
    recipeId: recipe.id,
    embedding: vector,
    textHash,
    model: EMBEDDING_MODEL_ID,
    updatedAtMs: Date.now(),
  });
  await enqueue({ kind: 'embedding_push', entity_id: recipe.id });
}
