import { test, expect } from './support/fixtures.js';

// Stable UUIDs so the shim payload round-trips through the Postgres
// sync layer (ingredients / instructions / refs all have uuid PKs).
const ID = {
  flour: '11111111-1111-1111-1111-111111111111',
  salt: '22222222-2222-2222-2222-222222222222',
  step1: '33333333-3333-3333-3333-333333333333',
  ing2Flour: '44444444-4444-4444-4444-444444444444',
  step2: '55555555-5555-5555-5555-555555555555',
} as const;

// Two-recipe shim payload — exercises the multi-recipe picker and the
// rich-field path (per-step consumed quantity, temperature, book/page
// provenance).
const FAKE_DRAFTS = [
  {
    title: 'Chewy Cookies',
    bookTitle: 'Weekend Baking',
    pageNumbers: [42],
    servings: { amount: 24, description: 'cookie' },
    description: 'The chewy one.',
    timeEstimate: '45 minutes',
    equipment: ['stand mixer'],
    ingredients: [
      {
        type: 'MEASURED',
        id: ID.flour,
        name: 'flour',
        quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
      },
      { type: 'VAGUE', id: ID.salt, name: 'salt', description: 'to taste' },
    ],
    instructions: [
      {
        id: ID.step1,
        stepNumber: 1,
        text: 'Mix 2 cup flour with the salt.',
        temperature: { value: 350, unit: 'FAHRENHEIT' },
        subInstructions: ['Use cold butter.'],
        notes: 'Do not overmix.',
        ingredientRefs: [
          {
            ingredientId: ID.flour,
            quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
          },
          { ingredientId: ID.salt },
        ],
      },
    ],
    leftover: [],
  },
  {
    title: 'Crispy Cookies',
    bookTitle: 'Weekend Baking',
    pageNumbers: [43],
    servings: { amount: 18, description: 'cookie' },
    ingredients: [
      {
        type: 'MEASURED',
        id: ID.ing2Flour,
        name: 'flour',
        quantity: { type: 'EXACT', amount: 1.5, unit: 'cup' },
      },
    ],
    instructions: [
      {
        id: ID.step2,
        stepNumber: 1,
        text: 'Roll thin.',
        ingredientRefs: [],
      },
    ],
    leftover: [],
  },
];

test.describe('OCR multi-recipe + rich metadata', () => {
  test('multi-recipe picker opens, pick lands on the editor, book/page + per-step quantity visible in cook mode', async ({
    authedPage: page,
  }) => {
    await page.addInitScript((draftsJson: string) => {
      const drafts = JSON.parse(draftsJson);
      window.__cybOcrShim = async () => drafts;
    }, JSON.stringify(FAKE_DRAFTS));
    await page.reload();

    await page.getByRole('link', { name: 'New collection' }).click();
    await page.getByLabel('Title').fill('Multi-Recipe Photo');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Multi-Recipe Photo' })).toBeVisible();

    // Upload path (not camera) — opens the file picker without the
    // `capture` hint.
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload image' }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: 'spread.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });

    // Picker appears with both recipes.
    const picker = page.getByTestId('ocr-recipe-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByText('Found 2 recipes')).toBeVisible();
    await expect(picker.getByText('Chewy Cookies')).toBeVisible();
    await expect(picker.getByText('Crispy Cookies')).toBeVisible();

    // Pick the first. Editor seeds from that draft.
    await picker.getByText('Chewy Cookies').click();
    await page.waitForURL(/\/recipes\/new$/);
    await expect(page.locator('main input').first()).toHaveValue('Chewy Cookies');

    // Save the recipe so we can land on the detail page.
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('heading', { name: 'Chewy Cookies' })).toBeVisible();

    // Book + page provenance surface on the detail page.
    await expect(page.getByText(/Weekend Baking/)).toBeVisible();
    await expect(page.getByText(/p\. 42/)).toBeVisible();
    await expect(page.getByText(/⏲ 45 minutes/)).toBeVisible();
    await expect(page.getByText('The chewy one.')).toBeVisible();
    await expect(page.getByText('stand mixer')).toBeVisible();

    // The step renders its temperature chip, sub-instruction, and notes.
    await expect(page.getByText(/350°F/)).toBeVisible();
    await expect(page.getByText('Use cold butter.')).toBeVisible();
    await expect(page.getByText('Do not overmix.')).toBeVisible();

    // Enter cook mode — the step should render the per-step consumed
    // quantity, not a fallback "2 cup" total.
    await page.getByRole('link', { name: 'Cook mode' }).click();
    await expect(
      page.getByLabel('Ingredients for this step').getByText(/2 cup flour/),
    ).toBeVisible();
  });
});
