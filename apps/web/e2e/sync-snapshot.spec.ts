import type { Page } from '@playwright/test';

import type { TestUser } from './support/admin.js';
import { seedUserLibrary } from './support/admin.js';
import { userAccessToken } from './support/embeddings.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './support/env.js';
import { expect, test } from './support/fixtures.js';

/**
 * First-load snapshot + /data-usage metrics.
 *
 * Asserts that a fresh full pull goes through the library-snapshot Edge
 * Function (the compact columnar MessagePack path) rather than the legacy
 * keyset fallback, that it lands every seeded recipe, and that the cycle
 * records a per-phase row into sync_transfer_events for the /data-usage page.
 * The E2E function server serves every function (no name), so
 * library-snapshot is reachable here.
 */

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

async function signInAndWaitForSync(
  page: Page,
  user: TestUser,
  syncTimeoutMs: number,
): Promise<void> {
  await page.goto('/sign-in');
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

interface TransferRow {
  cycle_id: string;
  direction: 'pull' | 'push';
  phase: string;
  rows: number;
  bytes: number;
  requests: number;
}

/** Read data_transfer_report AS the user (RLS enforced via their JWT). */
async function reportAsUser(token: string): Promise<TransferRow[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/data_transfer_report?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`reportAsUser ${r.status}: ${await r.text()}`);
  return (await r.json()) as TransferRow[];
}

test.describe('First-load snapshot + data usage', () => {
  test('full pull uses the snapshot path and records transfer metrics', async ({ user, page }) => {
    test.setTimeout(180_000);
    const RECIPE_COUNT = 25;
    await seedUserLibrary({
      ownerId: user.id,
      collectionTitle: 'Snapshot Test',
      recipeCount: RECIPE_COUNT,
    });

    await signInAndWaitForSync(page, user, 60_000);

    // The snapshot fast path logs "pull via snapshot: N recipes, …"; the
    // legacy fallback logs "pull recipes: N rows …" instead. Assert we took
    // the snapshot path and landed every seeded recipe.
    const log = (await page.evaluate(() => window.__cybSyncLog?.() ?? [])) as SyncLogEntry[];
    const snap = log.find((e) => e.message.startsWith('pull via snapshot:'));
    expect(snap, 'snapshot path should have been used (not the keyset fallback)').toBeTruthy();
    const m = /pull via snapshot: (\d+) recipes/.exec(snap!.message);
    expect(m, `expected recipe count in: ${snap!.message}`).toBeTruthy();
    expect(Number(m![1]), 'snapshot should land every seeded recipe').toBe(RECIPE_COUNT);

    // Progressive load: the grid is up (heading asserted at sign-in) and the
    // seeded recipes are visible as cards once metadata landed.
    await expect(page.getByText('Perf Recipe 1', { exact: false }).first()).toBeVisible();

    // /data-usage: the cycle records one row per metered phase via the
    // record_sync_transfer RPC (fire-and-forget), so poll the report.
    const token = await userAccessToken(user.email, user.password);
    await expect
      .poll(async () => (await reportAsUser(token)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    const rows = await reportAsUser(token);
    // The snapshot stages should be represented, and bytes pulled are tracked.
    const phases = Array.from(new Set(rows.map((r) => r.phase)));
    expect(
      phases.includes('snapshot_meta') || phases.includes('snapshot_bodies'),
      `expected a snapshot phase, got ${phases.join(', ')}`,
    ).toBeTruthy();
    const pulledBytes = rows
      .filter((r) => r.direction === 'pull')
      .reduce((acc, r) => acc + Number(r.bytes), 0);
    expect(pulledBytes, 'pull bytes should be metered').toBeGreaterThan(0);
  });
});
