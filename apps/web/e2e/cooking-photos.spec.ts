import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test.describe('Cooking entry photos', () => {
  test('attaches a photo to "I made this" and shows the thumbnail in history', async ({
    authedPage: page,
  }) => {
    test.setTimeout(60_000);
    await createRecipeViaUi(page, {
      collectionTitle: 'Photo Kitchen',
      recipeTitle: 'Photogenic Cake',
      ingredients: [{ kind: 'measured', amount: '2', unit: 'cup', name: 'flour' }],
      steps: ['Bake.'],
    });

    await page.getByTestId('i-made-this').click();
    await page.getByTestId('cook-notes').fill('Looked amazing.');
    await page.getByTestId('cook-photos').setInputFiles({
      name: 'cake.png',
      mimeType: 'image/png',
      buffer: readFileSync(resolve(FIXTURES, 'page1.png')),
    });
    await expect(page.getByTestId('photo-preview')).toHaveCount(1);
    await page.getByTestId('cook-submit').click();

    const history = page.getByTestId('cooking-history');
    await expect(history.getByText('Looked amazing.')).toBeVisible();
    // The stored photo renders as a signed-URL thumbnail in the entry.
    await expect(history.getByTestId('cook-photo').first()).toBeVisible({ timeout: 15_000 });
  });

  test('removes an individual selected photo before saving', async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Photo Editor',
      recipeTitle: 'Two Snaps',
      ingredients: [{ kind: 'vague', name: 'salt' }],
      steps: ['Cook.'],
    });

    await page.getByTestId('i-made-this').click();
    await page.getByTestId('cook-photos').setInputFiles([
      {
        name: 'a.png',
        mimeType: 'image/png',
        buffer: readFileSync(resolve(FIXTURES, 'page1.png')),
      },
      {
        name: 'b.png',
        mimeType: 'image/png',
        buffer: readFileSync(resolve(FIXTURES, 'page2.png')),
      },
    ]);
    await expect(page.getByTestId('photo-preview')).toHaveCount(2);

    // Drop the first; one remains.
    await page.getByRole('button', { name: 'Remove photo 1' }).click();
    await expect(page.getByTestId('photo-preview')).toHaveCount(1);

    await page.getByTestId('cook-submit').click();
    // Exactly the one kept photo lands on the entry.
    await expect(page.getByTestId('cooking-history').getByTestId('cook-photo')).toHaveCount(1, {
      timeout: 15_000,
    });
  });
});
