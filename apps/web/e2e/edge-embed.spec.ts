import { test, expect } from './support/fixtures.js';
import { createTestUser } from './support/admin.js';
import { EMBEDDING_STORED_MODEL } from '@cookyourbooks/domain';
import {
  cosine,
  createUserRecipe,
  fetchEmbedJob,
  userAccessToken,
  userCanReadEmbedding,
  waitForEmbedding,
} from './support/embeddings.js';

// Edge-function-level semantic success: prove the import-worker actually
// embeds recipes server-side (native Supabase.ai gte-small) into
// public.recipe_embeddings, completes the job cleanly, and produces
// *meaningful* vectors. API-only — no browser — so the guarantee is
// "the worker wrote a correct vector to Postgres", with no UI flake.
test.describe('Edge embedding worker', () => {
  // Real model + worker round-trip; generous over the 30s default.
  test.describe.configure({ timeout: 90_000 });

  test('embeds a recipe server-side and completes the job', async ({ user }) => {
    const { recipeId } = await createUserRecipe({
      ownerId: user.id,
      collectionTitle: 'Edge Embeds',
      recipeTitle: 'Spaghetti Bolognese',
      description: 'Slow-simmered beef and tomato sauce over pasta.',
      ingredients: ['ground beef', 'tomato', 'onion', 'garlic'],
    });

    const emb = await waitForEmbedding(recipeId, { timeoutMs: 75_000 });
    expect(emb.embedding.length).toBe(384);
    expect(emb.model).toBe(EMBEDDING_STORED_MODEL);
    expect(emb.textHash).toMatch(/^[0-9a-f]{64}$/);

    // The job finished cleanly — not stuck looping (the bug the audit found:
    // a preload failure used to requeue PENDING forever). A successful claim
    // bumps attempts once, so <= 2 means no retry churn.
    await expect
      .poll(async () => (await fetchEmbedJob(recipeId))?.status, { timeout: 10_000 })
      .toBe('DONE');
    const job = await fetchEmbedJob(recipeId);
    expect(job?.status).not.toBe('FAILED');
    expect(job?.attempts ?? 99).toBeLessThanOrEqual(2);
    expect(job?.last_error ?? null).toBeNull();
  });

  test('server vectors are semantically ordered', async ({ user }) => {
    // One collection, three recipes: two semantically near each other, one
    // far. Assert ORDERING only (related > unrelated) — never absolute
    // cosine thresholds, which are model-version fragile.
    const col = await createUserRecipe({
      ownerId: user.id,
      collectionTitle: 'Semantic Ordering',
      recipeTitle: 'Spaghetti Bolognese',
      description: 'Beef and tomato sauce over pasta.',
      ingredients: ['beef', 'tomato', 'pasta'],
    });
    const ragu = await createUserRecipe({
      ownerId: user.id,
      collectionTitle: 'Semantic Ordering',
      collectionId: col.collectionId,
      recipeTitle: 'Beef Ragu over Pasta',
      description: 'Slow-cooked minced beef in tomato, served on noodles.',
      ingredients: ['beef', 'tomato', 'noodles'],
    });
    const cake = await createUserRecipe({
      ownerId: user.id,
      collectionTitle: 'Semantic Ordering',
      collectionId: col.collectionId,
      recipeTitle: 'Chocolate Lava Cake',
      description: 'Molten dark chocolate dessert.',
      ingredients: ['chocolate', 'butter', 'eggs'],
    });

    // First wait drains all three (CLAIM_BATCH=8); the rest resolve fast.
    const vBolognese = await waitForEmbedding(col.recipeId, { timeoutMs: 80_000 });
    const vRagu = await waitForEmbedding(ragu.recipeId, { timeoutMs: 30_000 });
    const vCake = await waitForEmbedding(cake.recipeId, { timeoutMs: 30_000 });

    const related = cosine(vBolognese.embedding, vRagu.embedding);
    const far1 = cosine(vBolognese.embedding, vCake.embedding);
    const far2 = cosine(vRagu.embedding, vCake.embedding);
    expect(related).toBeGreaterThan(far1);
    expect(related).toBeGreaterThan(far2);
  });

  test('recipe embeddings are RLS-scoped to the owner', async ({ user }) => {
    // user (A) owns a private recipe; embed it server-side.
    const a = await createUserRecipe({
      ownerId: user.id,
      collectionTitle: 'Private A',
      recipeTitle: 'Secret Family Stew',
      description: 'A closely guarded recipe.',
      ingredients: ['beef', 'carrot'],
    });
    await waitForEmbedding(a.recipeId, { timeoutMs: 75_000 });

    const intruder = await createTestUser('embedintruder');
    try {
      // A second user must NOT see A's embedding (the recipe_embeddings_read
      // policy only exposes rows for owned or public collections).
      const intruderToken = await userAccessToken(intruder.email, intruder.password);
      expect(await userCanReadEmbedding(intruderToken, a.recipeId)).toBe(0);
      // Positive control: the owner CAN read their own embedding.
      const ownerToken = await userAccessToken(user.email, user.password);
      expect(await userCanReadEmbedding(ownerToken, a.recipeId)).toBe(1);
    } finally {
      await intruder.cleanup();
    }
  });
});
