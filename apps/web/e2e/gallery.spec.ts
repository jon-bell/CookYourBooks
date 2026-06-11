import { SUPABASE_URL } from './support/env.js';
import { expect, test, waitForSynced } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

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

    // Upload a cover to Zebra Cake from its recipe page (the cover-less
    // placeholder invites an upload; once a cover exists, the actions hide
    // behind the ⋯ overlay menu).
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload an image' }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(page.getByTestId('cover-menu')).toBeVisible({
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
    // Cover view is the default now; click it anyway to be explicit/robust.
    await page.getByRole('button', { name: 'Cover view' }).click();

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

    // In-collection cards don't repeat the collection name — the context
    // is already the collection.
    await expect(zebraCard.getByRole('link', { name: 'Gallerybook' })).toHaveCount(0);

    // Tapping the card opens that recipe.
    await zebraCard.getByRole('link').click();
    await expect(page).toHaveURL(/\/recipes\//);
    await expect(page.getByRole('heading', { name: 'Zebra Cake' })).toBeVisible();

    // Removing the cover (via the ⋯ overlay menu) brings the placeholder
    // invite back.
    await page.getByTestId('cover-menu').click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await expect(page.getByRole('button', { name: 'Upload an image' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
