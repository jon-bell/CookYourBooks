import { createTestUser } from './support/admin.js';
import { SUPABASE_SERVICE_ROLE, SUPABASE_URL } from './support/env.js';
import { expect, signIn, test } from './support/fixtures.js';

/**
 * Dark-mode legibility guard for the reported bug: the bulk-import
 * NavBanner ("X of Y" / prev-next) rendered a bright white bar in dark
 * mode because `bg-white/95` had no `dark:` counterpart. The static
 * `src/theme/darkVariants.test.ts` checker guards the class strings; this
 * E2E proves the fix renders — the banner's computed background is a dark
 * color, not near-white — with the app actually booted in dark mode.
 *
 * We seed a batch + one OCR_DONE item directly via the service role (the
 * item page reads the local cr-sqlite mirror, which `pullAll` fills on
 * login), then navigate straight to the item route so the NavBanner
 * renders. Seeding happens before signIn so the first pull picks it up —
 * the same owned-rows-before-login pattern discover/covers specs use.
 */

const THEME_STORAGE_KEY = 'cookyourbooks.theme.v1';

interface SeededBatch {
  batchId: string;
  itemId: string;
}

async function seedBatchWithItem(userId: string, batchName: string): Promise<SeededBatch> {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  const batchResp = await fetch(`${SUPABASE_URL}/rest/v1/import_batches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      owner_id: userId,
      name: batchName,
      source_kind: 'IMAGES',
      default_model: 'gemini-1.5-flash',
      default_provider: 'gemini',
      total_items: 1,
    }),
  });
  if (!batchResp.ok) {
    throw new Error(`seed batch failed: ${batchResp.status} ${await batchResp.text()}`);
  }
  const [batch] = (await batchResp.json()) as { id: string }[];

  const itemResp = await fetch(`${SUPABASE_URL}/rest/v1/import_items`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      batch_id: batch!.id,
      owner_id: userId,
      page_index: 0,
      storage_path: `${userId}/dark-mode-page.png`,
      status: 'OCR_DONE',
    }),
  });
  if (!itemResp.ok) {
    throw new Error(`seed item failed: ${itemResp.status} ${await itemResp.text()}`);
  }
  const [item] = (await itemResp.json()) as { id: string }[];
  return { batchId: batch!.id, itemId: item!.id };
}

test.describe('dark mode', () => {
  test('the import NavBanner renders a dark (not white) bar in dark mode', async ({ page }) => {
    const u = await createTestUser('darkmode');
    try {
      const batchName = 'Dark Mode Batch';
      const { batchId, itemId } = await seedBatchWithItem(u.id, batchName);

      // Persist the "dark" theme preference before the app boots so
      // ThemeProvider resolves to dark on first paint. addInitScript
      // re-runs on every navigation, so it also covers the later goto.
      await page.addInitScript(
        (args: { key: string; value: string }) => {
          window.localStorage.setItem(args.key, args.value);
        },
        { key: THEME_STORAGE_KEY, value: 'dark' },
      );

      await signIn(page, u);

      // 1. The app is genuinely in dark mode.
      await expect(page.locator('html')).toHaveClass(/dark/);

      // 2. Reach the item page that renders the NavBanner. The seeded
      // item synced into the local mirror during the login pull.
      await page.goto(`/import/${batchId}/items/${itemId}`);
      const backLink = page.getByRole('link', { name: new RegExp(batchName) });
      await expect(backLink).toBeVisible({ timeout: 20_000 });

      // 3. The banner's own background is a dark color, not near-white.
      // `bg-white/95` (the bug) computes to rgba(255,255,255,0.95) — sum
      // 765; the fixed `dark:bg-stone-900/95` computes to
      // rgba(28,25,23,0.95) — sum 76. Assert the channels are low.
      const bg = await page.evaluate((name) => {
        const link = Array.from(document.querySelectorAll('a')).find((a) =>
          a.textContent?.includes(name),
        );
        const banner = link?.closest('.sticky');
        return banner ? getComputedStyle(banner).backgroundColor : null;
      }, batchName);

      expect(bg, 'NavBanner background-color should be resolvable').not.toBeNull();
      const channels = (bg ?? '').match(/[\d.]+/g)?.map(Number) ?? [];
      const [r, g, b] = channels;
      expect(
        r !== undefined && g !== undefined && b !== undefined,
        `could not parse RGB from "${bg ?? 'null'}"`,
      ).toBe(true);
      expect(r! + g! + b!, `NavBanner background "${bg ?? 'null'}" should be dark`).toBeLessThan(360);
    } finally {
      await u.cleanup();
    }
  });
});
