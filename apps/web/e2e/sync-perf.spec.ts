import { test, expect } from './support/fixtures.js';
import { seedUserLibrary, seedUserImports } from './support/admin.js';
import type { Page } from '@playwright/test';
import type { TestUser } from './support/admin.js';

/**
 * Inline sign-in — copy of fixtures.signIn that lets the perf test wait
 * for 'Synced' with an extended timeout (the default 15s is too tight
 * for a pre-seeded 50-recipe library on a CI runner).
 */
async function signInAndWaitForSync(
  page: Page,
  user: TestUser,
  syncTimeoutMs: number,
): Promise<void> {
  page.on('console', (m) => {
    // Mirror sync logs and any error console output to the test
    // runner's stdout so we can see what the badge can't show us.
    if (m.type() === 'error' || m.text().startsWith('[sync]')) {
      // eslint-disable-next-line no-console
      console.log(`[browser:${m.type()}] ${m.text()}`);
    }
  });
  await page.goto('/sign-in');
  // Opt in to sync info-level console mirroring so the page.on('console')
  // hook above sees the per-phase logs. By default this is gated
  // (see syncLog.shouldMirrorInfo) because the IPC cost shows up on
  // iPad / remote-attached devtools.
  await page.evaluate(() => {
    localStorage.setItem('cookyourbooks.sync.consoleMirror', '1');
  });
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recipes', exact: true })).toBeVisible();
  await expect(page.locator('header button', { hasText: 'Synced' })).toBeVisible({
    timeout: syncTimeoutMs,
  });
}

interface SyncLogEntry {
  id: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

declare global {
  interface Window {
    __cybSyncLog?: () => SyncLogEntry[];
  }
}

/**
 * Sync perf regression tests. The numbers are intentionally generous —
 * we are guarding against the catastrophic regressions we hit in real
 * use (38s tx that wedged every reader, single-row inserts, etc), not
 * the tight bounds you'd want for a benchmark suite. The intent is to
 * fail loudly if anyone reintroduces an O(rows) per-row WASM round-trip
 * in the pull path or the upsert path.
 */
test.describe('Sync performance', () => {
  test('fresh-library pull of 50 recipes completes within budget', async ({
    user,
    page,
  }) => {
    test.setTimeout(180_000);
    const RECIPE_COUNT = 50;
    const PULL_BUDGET_MS = 20_000;
    const CYCLE_BUDGET_MS = 25_000;
    await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Perf Test',
      recipeCount: RECIPE_COUNT,
    });
    await signInAndWaitForSync(page, user, 60_000);

    const log = (await page.evaluate(() => window.__cybSyncLog?.() ?? [])) as SyncLogEntry[];
    const cycleStart = log.find((e) => e.message === 'cycle: start');
    const cycleIdle = log.find((e) => e.message.startsWith('cycle: idle'));
    const pullRecipes = log.find((e) => e.message.startsWith('pull recipes:'));
    const pullComplete = log.find((e) => e.message.startsWith('pull complete'));

    expect(cycleStart, 'cycle: start should have logged').toBeTruthy();
    expect(cycleIdle, 'cycle: idle should have logged').toBeTruthy();
    expect(pullRecipes, 'pull recipes: should have logged').toBeTruthy();
    expect(pullComplete, 'pull complete should have logged').toBeTruthy();

    // Parse "pull recipes: 50 rows in Xms"
    const pullMatch = /pull recipes: (\d+) rows in (\d+)ms/.exec(pullRecipes!.message);
    expect(pullMatch, `expected timing in: ${pullRecipes!.message}`).toBeTruthy();
    const pulledCount = Number(pullMatch![1]);
    const pullMs = Number(pullMatch![2]);
    expect(pulledCount, 'pull should land all seeded recipes').toBe(RECIPE_COUNT);
    expect(pullMs, `pull recipes phase under ${PULL_BUDGET_MS}ms`).toBeLessThan(PULL_BUDGET_MS);

    const cycleMatch = /cycle: idle \(took (\d+)ms\)/.exec(cycleIdle!.message);
    expect(cycleMatch, `expected cycle timing in: ${cycleIdle!.message}`).toBeTruthy();
    const cycleMs = Number(cycleMatch![1]);
    expect(cycleMs, `full cycle under ${CYCLE_BUDGET_MS}ms`).toBeLessThan(CYCLE_BUDGET_MS);

    // No lock-contention warning means the chunked-upsert path released
    // the SQLite mutex often enough for other readers to interleave.
    const lockWarnings = log.filter(
      (e) => e.level === 'warn' && e.message.startsWith('db lock: still waiting'),
    );
    expect(
      lockWarnings.length,
      `no readers should stall for >3s — got ${lockWarnings.length} warnings`,
    ).toBe(0);
  });

  test('library page remains interactive during a 50-recipe pull', async ({
    user,
    page,
  }) => {
    test.setTimeout(180_000);
    // Smaller threshold than the cold pull — we're testing UI responsiveness
    // mid-pull, not raw throughput.
    const NAV_BUDGET_MS = 8_000;
    await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Interactive Perf',
      recipeCount: 50,
    });
    await signInAndWaitForSync(page, user, 60_000);
    // signIn awaits 'Synced' so by here the cold pull is done. Force a
    // fresh cycle to repro the contention scenario, then race UI nav
    // against it.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    // Header shows 'Syncing…' as soon as cycle: start fires.
    await expect(page.locator('header button[title]')).toContainText(/Syncing/, {
      timeout: 10_000,
    });
    const navStart = Date.now();
    await page.getByRole('link', { name: 'Shopping' }).click();
    // Shopping page heading is the smoke signal that the route mounted
    // and the local SQLite read returned. If the recipe-upsert tx
    // starves the read, this hangs.
    await expect(page.getByRole('heading', { name: /shopping/i })).toBeVisible({
      timeout: NAV_BUDGET_MS,
    });
    const navMs = Date.now() - navStart;
    expect(
      navMs,
      `nav to Shopping mid-pull under ${NAV_BUDGET_MS}ms (got ${navMs}ms)`,
    ).toBeLessThan(NAV_BUDGET_MS);
    await expect(page.locator('header button', { hasText: 'Synced' })).toBeVisible({
      timeout: 60_000,
    });
  });

  test('tail-table pull (50 import_items) stays under budget', async ({
    user,
    page,
  }) => {
    test.setTimeout(180_000);
    // 5 batches × 10 items — exercises the bulk import_batches +
    // import_items path with enough rows that the per-row codepath
    // would visibly regress here.
    const ITEM_COUNT = 50;
    const TAIL_BUDGET_MS = 8_000;
    await seedUserImports({
      ownerId: user.id,
      batchCount: 5,
      itemsPerBatch: 10,
    });
    await signInAndWaitForSync(page, user, 60_000);

    const log = (await page.evaluate(
      () => window.__cybSyncLog?.() ?? [],
    )) as SyncLogEntry[];
    const importsDone = log.find((e) => e.message.startsWith('pull imports done'));
    expect(importsDone, 'pull imports done should have logged').toBeTruthy();
    const importsMatch = /pull imports done in (\d+)ms/.exec(importsDone!.message);
    expect(importsMatch).toBeTruthy();
    const importsMs = Number(importsMatch![1]);
    expect(
      importsMs,
      `imports phase under ${TAIL_BUDGET_MS}ms (got ${importsMs}ms)`,
    ).toBeLessThan(TAIL_BUDGET_MS);

    const data = importsDone!.data as { items?: number } | undefined;
    expect(data?.items).toBe(ITEM_COUNT);

    // No lock-wait warnings — the bulk + trigger-suppress path keeps
    // the mutex short enough that no reader stalls >3s.
    const lockWarnings = log.filter(
      (e) => e.level === 'warn' && e.message.startsWith('db lock: still waiting'),
    );
    expect(lockWarnings.length, 'no reader should stall during tail pull').toBe(0);
  });
});
