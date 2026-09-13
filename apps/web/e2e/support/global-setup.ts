import { chromium } from '@playwright/test';

import { resolveChromiumPath } from './chromiumPath.js';
import { startFunctionsServer } from './functionsServer.js';

/**
 * Warm the dev server before the first test runs.
 *
 * Playwright's `webServer.url` probe only waits for an HTTP 200 on `/`, but
 * `pnpm dev` (Vite) still has to optimize deps and transform the module graph
 * on the first real request. That work regularly outlasts the 15s action
 * timeout, so whichever test happened to run first would fail on the sign-in
 * form while every later test passed. Load the sign-in route once here and
 * wait for its form, so the cost lands in setup instead of an arbitrary test.
 *
 * Skipped on CI, which serves a prebuilt `dist/` through `vite preview` and
 * therefore has no transform step to pay for.
 */
async function warmDevServer(): Promise<void> {
  if (process.env.CI) return;
  const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const browser = await chromium.launch({ executablePath: resolveChromiumPath() });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'load', timeout: 120_000 });
    await page.getByLabel('Email').waitFor({ state: 'visible', timeout: 120_000 });
  } catch {
    // Best-effort: a failure here shouldn't mask the real test failure. The
    // suite will surface it anyway if the server genuinely isn't up.
  } finally {
    await browser.close();
  }
}

export default async function globalSetup(): Promise<void> {
  await startFunctionsServer();
  await warmDevServer();
}
