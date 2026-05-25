import { test, expect } from './support/fixtures.js';

// Two canned per-variant outputs the bakeoff shim hands back. The shapes
// match what the real Gemini / OpenAI parsers would produce after running
// `parseLlmJson`, plus the usage block the runner needs to compute cost.
//
// They differ on title, an ingredient, and an instruction so the diff
// view has something to render.
const FAKE_RESULTS: Record<string, {
  title: string;
  ingredientName: string;
  stepText: string;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number;
}> = {
  fast: {
    title: 'Quick Cookies',
    ingredientName: 'flour',
    stepText: 'Mix everything in one bowl.',
    promptTokens: 800,
    completionTokens: 200,
    elapsedMs: 500,
  },
  pro: {
    title: 'Quick Cookies (revised)',
    ingredientName: 'all-purpose flour',
    stepText: 'Cream butter and sugar until fluffy, then fold in the dry ingredients.',
    promptTokens: 1200,
    completionTokens: 400,
    elapsedMs: 1500,
  },
};

async function installBakeoffShim(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((payload: string) => {
    const fakes = JSON.parse(payload) as typeof FAKE_RESULTS;
    window.__cybBakeoffShim = async (variant) => {
      // Route by the variant's persisted seed id. Tests rely on these
      // ids surviving any localStorage round-trip, which they do because
      // the page seeds `DEFAULT_VARIANTS` on first load and writes them
      // through.
      const key = variant.id === 'seed-flash' ? 'fast' : 'pro';
      const fake = fakes[key]!;
      const draft = {
        title: fake.title,
        ingredients: [
          {
            type: 'MEASURED',
            id: '11111111-1111-1111-1111-111111111111',
            name: fake.ingredientName,
            quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
          },
        ],
        instructions: [
          {
            id: '22222222-2222-2222-2222-222222222222',
            stepNumber: 1,
            text: fake.stepText,
            ingredientRefs: [],
          },
        ],
        leftover: [],
      };
      return {
        drafts: [draft],
        rawText: JSON.stringify({ recipes: [draft] }),
        usage: {
          promptTokens: fake.promptTokens,
          completionTokens: fake.completionTokens,
        },
        elapsedMs: fake.elapsedMs,
      };
    };
  }, JSON.stringify(FAKE_RESULTS));
}

async function gotoBakeoff(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/import/bakeoff');
  await expect(page.getByRole('heading', { name: 'OCR bakeoff' })).toBeVisible();
}

async function uploadFakeImage(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('bakeoff-file-input').setInputFiles({
    name: 'recipe.jpg',
    mimeType: 'image/jpeg',
    // 4-byte SOI/EOI stub — the shim never decodes the bytes.
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
}

test.describe('OCR bakeoff', () => {
  test('races two variants against the same photo and shows per-variant cost / latency / output', async ({
    authedPage: page,
  }) => {
    await installBakeoffShim(page);
    // The bakeoff page reads variants from localStorage on mount; clear
    // any state a prior test left behind so we land on the seed pair.
    await page.evaluate(() => localStorage.removeItem('cookyourbooks.bakeoff.v1'));

    await gotoBakeoff(page);

    // Default matrix is the two seed variants — verify both render.
    const variants = page.getByTestId('bakeoff-variant');
    await expect(variants).toHaveCount(2);
    await expect(page.getByLabel('Variant 1 name')).toHaveValue('Gemini Flash');
    await expect(page.getByLabel('Variant 2 name')).toHaveValue('Gemini Pro');

    await uploadFakeImage(page);

    await page.getByTestId('bakeoff-run').click();

    const rows = page.getByTestId('bakeoff-result-row');
    await expect(rows).toHaveCount(2);

    // Each row should reach OK status. The shim resolves quickly but the
    // runner still measures elapsed time, so both rows should render the
    // per-variant outputs.
    await expect(rows.nth(0).getByText('OK')).toBeVisible({ timeout: 10_000 });
    await expect(rows.nth(1).getByText('OK')).toBeVisible({ timeout: 10_000 });

    // Token usage formats with thousands separators and pairs in/out.
    await expect(rows.nth(0)).toContainText('800 / 200');
    await expect(rows.nth(1)).toContainText('1,200 / 400');

    // The cheap variant's elapsed-time should be the shim-reported 0.50 s.
    await expect(rows.nth(0)).toContainText('0.50 s');
    await expect(rows.nth(1)).toContainText('1.50 s');

    // Each row surfaces the parsed title in the output summary cell.
    await expect(rows.nth(0)).toContainText('Quick Cookies');
    await expect(rows.nth(1)).toContainText('Quick Cookies (revised)');
  });

  test('diff view highlights additions and deletions between two variants', async ({
    authedPage: page,
  }) => {
    await installBakeoffShim(page);
    await page.evaluate(() => localStorage.removeItem('cookyourbooks.bakeoff.v1'));

    await gotoBakeoff(page);
    await uploadFakeImage(page);
    await page.getByTestId('bakeoff-run').click();

    const diff = page.getByTestId('bakeoff-diff');
    await expect(diff).toBeVisible({ timeout: 10_000 });

    // The diff selectors default to the first two successful variants.
    await expect(page.getByLabel('Diff left variant')).toHaveValue(/.+/);
    await expect(page.getByLabel('Diff right variant')).toHaveValue(/.+/);

    // The diff text exists — at minimum it contains an added line for
    // "all-purpose flour" (only in the second variant) and a deletion for
    // the bare "flour" name from the first.
    await expect(diff.locator('[data-diff-kind="add"]')).toContainText('all-purpose flour');
    await expect(diff.locator('[data-diff-kind="del"]')).toContainText(/flour/);
  });

  test('variants persist to localStorage and survive a reload', async ({
    authedPage: page,
  }) => {
    await page.evaluate(() => localStorage.removeItem('cookyourbooks.bakeoff.v1'));

    await gotoBakeoff(page);
    await page.getByLabel('Variant 1 name').fill('My Custom Variant');
    // Blur the field so React commits the change before reload.
    await page.getByLabel('Variant 1 name').press('Tab');

    // Round-trip the localStorage value directly — both as a guarantee that
    // we wrote it and to keep the assertion narrow if the page restructures.
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('cookyourbooks.bakeoff.v1') ?? '[]'),
    );
    expect(stored[0]?.name).toBe('My Custom Variant');

    await page.reload();
    await expect(page.getByLabel('Variant 1 name')).toHaveValue('My Custom Variant');
  });

  test('blocks "Run bakeoff" until an image is selected', async ({ authedPage: page }) => {
    await page.evaluate(() => localStorage.removeItem('cookyourbooks.bakeoff.v1'));
    await gotoBakeoff(page);
    await expect(page.getByTestId('bakeoff-run')).toBeDisabled();
    await uploadFakeImage(page);
    await expect(page.getByTestId('bakeoff-run')).toBeEnabled();
  });

  test('"Bakeoff" link on the Import list navigates to the bakeoff page', async ({
    authedPage: page,
  }) => {
    await page.goto('/import');
    await page.getByRole('link', { name: 'Bakeoff' }).click();
    await expect(page).toHaveURL(/\/import\/bakeoff$/);
    await expect(page.getByRole('heading', { name: 'OCR bakeoff' })).toBeVisible();
  });
});
