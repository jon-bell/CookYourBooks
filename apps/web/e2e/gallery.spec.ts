import { test, expect, waitForSynced } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';
import { SUPABASE_URL } from './support/env.js';

// 1×1 transparent PNG, the smallest valid image the browser will render.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d494441547801636060000000000005000157be1dd20000000049454e44ae426082',
  'hex',
);

const COVERS_URL = new RegExp(
  `${SUPABASE_URL.replace(/[/.]/g, '\\$&')}/storage/v1/object/public/covers/`,
);

test.describe('Collection gallery view', () => {
  test('covers lead, sort is overridden, and a card links to its recipe', async ({
    authedPage: page,
  }) => {
    // First recipe (created first → first in creation/manual order; left
    // cover-less and named so it sorts FIRST by name).
    await createRecipeViaUi(page, {
      collectionTitle: 'Gallerybook',
      recipeTitle: 'Apple Pie',
      ingredients: [{ kind: 'vague', name: 'sugar' }],
      steps: ['Bake.'],
    });

    // Second recipe in the same collection (created second; named to sort
    // LAST by name) — this is the one we give a cover to.
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Gallerybook' }).first().click();
    await page.getByRole('link', { name: 'Add recipe' }).click();
    await page.locator('main input').first().fill('Zebra Cake');
    await page.locator('ol textarea').first().fill('Bake.');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Zebra Cake' })).toBeVisible();

    // Upload a cover to Zebra Cake from its recipe page.
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add cover' }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(page.getByRole('button', { name: 'Replace cover' })).toBeVisible({
      timeout: 10_000,
    });
    // Let the cover's local save + sync echoes settle before reading it from a
    // different query (the collection list) on another page.
    await waitForSynced(page);

    // Back to the collection. Hard-reload so the recipe list is read from the
    // freshly-synced state — covers converge through sync, and a clean boot
    // (which re-pulls from Supabase, where the cover is durably stored) makes
    // that deterministic even when the runner is under load.
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Gallerybook' }).first().click();
    await expect(page.getByRole('heading', { name: 'Gallerybook' })).toBeVisible();
    await page.reload();
    await waitForSynced(page);
    await page.getByRole('button', { name: 'Gallery view' }).click();

    // Force Name (A–Z) sort so name order alone would put Apple Pie first and
    // Zebra Cake last — proving covers-first overrides the active sort.
    await page.getByLabel('Sort').selectOption('name');

    const cards = page
      .locator('ul a[href*="/recipes/"]')
      .filter({ hasText: /Zebra Cake|Apple Pie/ });
    await expect(cards).toHaveCount(2);

    // Wait until the cover has propagated into the gallery (Zebra Cake's card
    // renders its cover from the public covers bucket). Once it's there,
    // covers-first ordering is settled.
    const zebraCard = page.locator('li', { hasText: 'Zebra Cake' });
    await expect(zebraCard.getByRole('img', { name: 'Zebra Cake' })).toHaveAttribute(
      'src',
      COVERS_URL,
      { timeout: 15_000 },
    );

    // Covers-first: the recipe WITH a cover (Zebra Cake) leads despite sorting
    // last by name and being created last. Compute both indices each poll
    // (never freeze one side) so the check reflects the settled order.
    const order = async () => {
      const texts = await cards.allInnerTexts();
      return {
        zebra: texts.findIndex((t) => t.includes('Zebra Cake')),
        apple: texts.findIndex((t) => t.includes('Apple Pie')),
      };
    };
    await expect
      .poll(async () => {
        const o = await order();
        return o.zebra >= 0 && o.apple >= 0 && o.zebra < o.apple;
      })
      .toBe(true);

    // Tapping the card opens that recipe.
    await zebraCard.getByRole('link').click();
    await expect(page).toHaveURL(/\/recipes\//);
    await expect(page.getByRole('heading', { name: 'Zebra Cake' })).toBeVisible();
  });

  test('shares a recipe as a composed social-card image', async ({ authedPage: page }) => {
    // Stub Web Share (files) so we can capture the shared payload instead of
    // popping a real OS sheet. Registered before any navigation, so it's in
    // place by the time the gallery renders.
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: unknown };
      w.__shared = null;
      const stub = {
        canShare: (data?: { files?: unknown[] }) =>
          !!data && Array.isArray(data.files) && data.files.length > 0,
        share: async (data: { title?: string; text?: string; files?: File[] }) => {
          const f = data.files?.[0];
          w.__shared = {
            title: data.title ?? null,
            text: data.text ?? null,
            fileName: f?.name ?? null,
            fileType: f?.type ?? null,
            fileSize: f?.size ?? 0,
          };
        },
      };
      try {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: stub.canShare });
        Object.defineProperty(navigator, 'share', { configurable: true, value: stub.share });
      } catch {
        Object.assign(navigator, stub);
      }
    });

    await createRecipeViaUi(page, {
      collectionTitle: 'Sharebook',
      recipeTitle: 'Choco Tart',
      ingredients: [{ kind: 'vague', name: 'chocolate' }],
      steps: ['Bake.'],
    });

    // Give it a cover so the composed card carries a photo.
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add cover' }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(page.getByRole('button', { name: 'Replace cover' })).toBeVisible({
      timeout: 10_000,
    });
    // Let the cover's local save + sync echoes settle before reading it from a
    // different query (the collection list) on another page.
    await waitForSynced(page);

    // Open the collection, switch to Gallery, and share the card. Hard-reload
    // first so the recipe list is read from the freshly-synced state (the cover
    // converges through sync; a clean boot re-pulls it deterministically).
    await page.getByRole('link', { name: 'Library' }).click();
    await page.getByRole('link', { name: 'Sharebook' }).first().click();
    await expect(page.getByRole('heading', { name: 'Sharebook' })).toBeVisible();
    await page.reload();
    await waitForSynced(page);
    await page.getByRole('button', { name: 'Gallery view' }).click();
    // Wait for the cover to land in the gallery so the composed card carries the photo.
    await expect(
      page.locator('li', { hasText: 'Choco Tart' }).getByRole('img', { name: 'Choco Tart' }),
    ).toHaveAttribute('src', COVERS_URL, { timeout: 15_000 });
    await page.getByRole('button', { name: 'Share Choco Tart' }).click();

    // A PNG card image reached the share sheet, named after the recipe, with
    // the recipe link in the share text.
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __shared: { fileName?: string } | null }).__shared?.fileName ?? null,
        ),
      )
      .toBe('choco-tart.png');
    const shared = await page.evaluate(
      () => (window as unknown as { __shared: Record<string, unknown> | null }).__shared,
    );
    expect(shared?.fileType).toBe('image/png');
    expect(shared?.fileSize as number).toBeGreaterThan(1000);
    expect(String(shared?.text)).toContain('/recipes/');
    expect(shared?.title).toBe('Choco Tart');

    // The share button didn't hijack the card's link.
    await page.locator('li', { hasText: 'Choco Tart' }).getByRole('link').click();
    await expect(page).toHaveURL(/\/recipes\//);
  });
});
