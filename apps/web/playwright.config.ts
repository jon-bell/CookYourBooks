import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Pick a chromium binary:
//   1. `PLAYWRIGHT_CHROMIUM_PATH` env (set by CI or devs with their own copy).
//   2. A known local cache path — works on the primary dev box without extra
//      setup.
//   3. Otherwise let Playwright pick up whichever browser `playwright install`
//      brought down.
const LOCAL_DEV_CHROMIUM = '/home/jon/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  (existsSync(LOCAL_DEV_CHROMIUM) ? LOCAL_DEV_CHROMIUM : undefined);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Parallel workers contend for a single local Supabase and (especially)
  // a single realtime channel per-user, which causes flakes. Since each
  // test is already fast (well under a second of Supabase I/O), serializing
  // on one worker is both stable and nearly as quick.
  fullyParallel: false,
  workers: 1,
  // Retries help against genuine flake (realtime propagation timing, etc.)
  // but mask real bugs if left on in dev. Keep them off locally.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Local dev uses `vite` for HMR. CI serves the prebuilt `dist/` with
    // `vite preview` — no dep-optimization pass, no HMR websocket, just
    // static files. The `pnpm build` step earlier in the pipeline
    // produces the artifacts this server consumes.
    command: process.env.CI
      ? 'pnpm exec vite preview --port 5173 --strictPort'
      : 'pnpm dev',
    url: 'http://localhost:5173/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Stream the server's output in CI so a boot failure is diagnosable
    // from the job log; locally keep stdout quiet so `pnpm dev`'s noise
    // doesn't drown the test reporter.
    stdout: process.env.CI ? 'pipe' : 'ignore',
    stderr: 'pipe',
  },
});
