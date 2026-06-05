import { test, expect, waitForSynced } from './support/fixtures.js';
import { adminGet } from './support/admin.js';
import { seedOcrFixture, type FakeRecipeDraft } from './support/imports.js';
import type { Page } from '@playwright/test';

// The video-import Edge Function runs with VIDEO_IMPORT_MOCK_MODE=1 in E2E
// (set in functionsServer.ts), so it reads canned drafts from the shared
// `ocr_test_fixtures` table keyed by the (normalized) video URL instead of
// calling Gemini / oEmbed. Seed a fixture per URL, then drive the UI.

function recipeDraft(title: string, ingredientName: string): FakeRecipeDraft {
  return {
    title,
    servings: { amount: 4 },
    ingredients: [
      { type: 'MEASURED', name: ingredientName, quantity: { type: 'EXACT', amount: 2, unit: 'cup' } },
      { type: 'VAGUE', name: 'salt' },
    ],
    instructions: [
      { stepNumber: 1, text: 'Mix everything.' },
      { stepNumber: 2, text: 'Cook until done.' },
    ],
  };
}

async function seedVideo(url: string, draftOrDrafts: FakeRecipeDraft | FakeRecipeDraft[]) {
  await seedOcrFixture({
    storagePath: url,
    provider: 'gemini',
    kind: 'recipe',
    upsert: true,
    ...(Array.isArray(draftOrDrafts) ? { drafts: draftOrDrafts } : { draft: draftOrDrafts }),
  });
}

async function extractViaUi(page: Page, url: string) {
  await page.goto('/import/link');
  await page.getByTestId('video-url-input').fill(url);
  await page.getByRole('button', { name: 'Extract recipe' }).click();
}

interface CollectionRow {
  id: string;
  title: string;
  source_type: string;
  owner_id: string;
}
interface RecipeRow {
  id: string;
  title: string;
  collection_id: string;
  source_url: string | null;
}

async function webCollections(userId: string): Promise<CollectionRow[]> {
  return adminGet<CollectionRow[]>(
    `/rest/v1/recipe_collections?select=id,title,source_type,owner_id&owner_id=eq.${userId}&source_type=eq.WEBSITE`,
  );
}
async function recipesByTitle(title: string): Promise<RecipeRow[]> {
  return adminGet<RecipeRow[]>(
    `/rest/v1/recipes?select=id,title,collection_id,source_url&title=eq.${encodeURIComponent(title)}`,
  );
}

test.describe('video link import', () => {
  test('imports a YouTube recipe into an auto-created YouTube collection', async ({
    authedPage: page,
    user,
  }) => {
    const url = 'https://www.youtube.com/watch?v=happy-path';
    await seedVideo(url, recipeDraft('Skillet Cornbread', 'cornmeal'));

    await extractViaUi(page, url);

    // Single draft → auto-saves and lands on the recipe page.
    await page.waitForURL(/\/collections\/[0-9a-f-]+\/recipes\/[0-9a-f-]+$/, { timeout: 20_000 });
    await waitForSynced(page);

    const cols = await webCollections(user.id);
    expect(cols.filter((c) => c.title === 'YouTube')).toHaveLength(1);
    const recipes = await recipesByTitle('Skillet Cornbread');
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.collection_id).toBe(cols.find((c) => c.title === 'YouTube')!.id);
    expect(recipes[0]!.source_url).toBe(url);
  });

  test('reuses one YouTube collection across multiple imports', async ({
    authedPage: page,
    user,
  }) => {
    const a = 'https://youtu.be/first-vid';
    const b = 'https://www.youtube.com/watch?v=second-vid';
    await seedVideo(a, recipeDraft('First Bake', 'flour'));
    await seedVideo(b, recipeDraft('Second Bake', 'sugar'));

    await extractViaUi(page, a);
    await page.waitForURL(/\/recipes\/[0-9a-f-]+$/, { timeout: 20_000 });
    await waitForSynced(page);
    await extractViaUi(page, b);
    await page.waitForURL(/\/recipes\/[0-9a-f-]+$/, { timeout: 20_000 });
    await waitForSynced(page);

    const cols = await webCollections(user.id);
    expect(cols.filter((c) => c.title === 'YouTube')).toHaveLength(1);
    const ytId = cols.find((c) => c.title === 'YouTube')!.id;
    const all = await adminGet<RecipeRow[]>(
      `/rest/v1/recipes?select=id,title,collection_id&collection_id=eq.${ytId}`,
    );
    expect(all).toHaveLength(2);
  });

  test('imports a TikTok recipe from its caption', async ({ authedPage: page, user }) => {
    const url = 'https://www.tiktok.com/@chef/video/12345';
    await seedVideo(url, recipeDraft('Viral Pasta', 'spaghetti'));

    await extractViaUi(page, url);
    await page.waitForURL(/\/recipes\/[0-9a-f-]+$/, { timeout: 20_000 });
    await waitForSynced(page);

    const cols = await webCollections(user.id);
    expect(cols.filter((c) => c.title === 'TikTok')).toHaveLength(1);
  });

  test('Instagram falls back to a pasted caption', async ({ authedPage: page, user }) => {
    const url = 'https://www.instagram.com/reel/abcdef/';
    await seedVideo(url, recipeDraft('Reel Brownies', 'cocoa'));

    await extractViaUi(page, url);
    // No server token + no caption → the caption textarea appears.
    const captionBox = page.getByTestId('video-caption-input');
    await expect(captionBox).toBeVisible({ timeout: 20_000 });
    await captionBox.fill('Brownies: 1 cup cocoa, bake 25 min.');
    await page.getByRole('button', { name: 'Extract recipe' }).click();

    await page.waitForURL(/\/recipes\/[0-9a-f-]+$/, { timeout: 20_000 });
    await waitForSynced(page);
    const cols = await webCollections(user.id);
    expect(cols.filter((c) => c.title === 'Instagram')).toHaveLength(1);
  });

  test('lets the user pick when multiple recipes are found', async ({
    authedPage: page,
  }) => {
    const url = 'https://www.youtube.com/watch?v=two-recipes';
    await seedVideo(url, [
      recipeDraft('Recipe One', 'oats'),
      recipeDraft('Recipe Two', 'honey'),
    ]);

    await extractViaUi(page, url);
    await expect(page.getByText('Found 2 recipes', { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'Recipe Two', exact: false }).click();
    await page.waitForURL(/\/recipes\/[0-9a-f-]+$/, { timeout: 20_000 });
    await waitForSynced(page);

    expect(await recipesByTitle('Recipe Two')).toHaveLength(1);
    // The unpicked draft is not saved.
    expect(await recipesByTitle('Recipe One')).toHaveLength(0);
  });

  test('rejects an unsupported URL without saving anything', async ({
    authedPage: page,
    user,
  }) => {
    await extractViaUi(page, 'https://example.com/not-a-video');
    await expect(page.getByText('supported', { exact: false })).toBeVisible({ timeout: 20_000 });
    expect(await webCollections(user.id)).toHaveLength(0);
  });

  test('deep-link ?url= auto-extracts (mobile share-target contract)', async ({
    authedPage: page,
    user,
  }) => {
    const url = 'https://www.youtube.com/watch?v=shared-link';
    await seedVideo(url, recipeDraft('Shared Stew', 'carrot'));

    await page.goto(`/import/link?url=${encodeURIComponent(url)}`);
    await page.waitForURL(/\/collections\/[0-9a-f-]+\/recipes\/[0-9a-f-]+$/, { timeout: 20_000 });
    await waitForSynced(page);

    const recipes = await recipesByTitle('Shared Stew');
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.source_url).toBe(url);
    const cols = await webCollections(user.id);
    expect(recipes[0]!.collection_id).toBe(cols.find((c) => c.title === 'YouTube')!.id);
  });
});
