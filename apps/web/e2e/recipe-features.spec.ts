import { test, expect } from './support/fixtures.js';
import { createRecipeViaUi } from './support/helpers.js';

test.describe('Recipe features: scale, convert, export, cook mode', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await createRecipeViaUi(page, {
      collectionTitle: 'Feature Fixtures',
      recipeTitle: 'Test Cookies',
      servings: { amount: '12', description: 'cookies' },
      ingredients: [
        { kind: 'measured', amount: '2', unit: 'cup', name: 'flour' },
        { kind: 'measured', amount: '1', unit: 'tablespoon', name: 'sugar' },
        { kind: 'vague', name: 'salt' },
      ],
      steps: ['Mix everything.', 'Bake for 10 minutes.'],
    });
  });

  test('scales to 2× and the servings + ingredient amounts double', async ({
    authedPage: page,
  }) => {
    await page.getByRole('button', { name: '2×' }).click();
    await expect(page.getByText('Serves 24 cookies')).toBeVisible();
    await expect(page.getByText('4 cup flour')).toBeVisible();
    await expect(page.getByText('2 tablespoon sugar')).toBeVisible();
  });

  test('scales to 0.5× with the custom input', async ({ authedPage: page }) => {
    const scale = page.getByRole('spinbutton');
    await scale.fill('0.5');
    await expect(page.getByText(/Serves 6 cookies/)).toBeVisible();
  });

  test('converts tablespoon → teaspoon for the sugar row', async ({ authedPage: page }) => {
    await page.getByRole('combobox', { name: /Convert to/i }).selectOption('teaspoon');
    // 1 tbsp sugar → 3 tsp sugar
    await expect(page.getByText(/3 teaspoon sugar/)).toBeVisible();
  });

  test('"Share" falls back to a Markdown download in desktop Chromium', async ({
    authedPage: page,
  }) => {
    // The share helper prefers `navigator.share` but headless Chromium on
    // Linux doesn't expose it, so it downloads a .md file instead — which
    // is exactly the fallback behaviour we need to cover.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Share' }).click(),
    ]);
    const name = download.suggestedFilename();
    expect(name).toMatch(/test-cookies\.md$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    expect(body).toContain('# Test Cookies');
    expect(body).toContain('## Ingredients');
    expect(body).toContain('2 cup flour');
    expect(body).toContain('- salt');
    expect(body).toContain('1. Mix everything.');
  });

  test('"Share" uses the Web Share API when it is available', async ({
    authedPage: page,
  }) => {
    // Polyfill a minimal navigator.share so we cover the happy path of the
    // Web Share branch without relying on the browser's implementation.
    await page.addInitScript(() => {
      (navigator as unknown as {
        share: (d: { title?: string; text?: string }) => Promise<void>;
      }).share = async (d) => {
        (window as unknown as { __lastShare: unknown }).__lastShare = d;
      };
    });
    await page.reload();

    await page.getByRole('button', { name: 'Share' }).click();
    const shared = await page.evaluate(
      () => (window as unknown as { __lastShare?: { title?: string; text?: string } }).__lastShare,
    );
    expect(shared?.title).toBe('Test Cookies');
    expect(shared?.text).toMatch(/# Test Cookies/);
    expect(shared?.text).toMatch(/2 cup flour/);
  });

  test('cook mode: keyboard navigation moves between steps and wakes screen', async ({
    authedPage: page,
  }) => {
    await page.getByRole('link', { name: 'Cook mode' }).click();
    await expect(page.getByText('Step 1 of 2')).toBeVisible();
    await expect(page.getByText('Mix everything.')).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByText('Step 2 of 2')).toBeVisible();
    await expect(page.getByText('Bake for 10 minutes.')).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(page.getByText('Step 1 of 2')).toBeVisible();
  });
});
