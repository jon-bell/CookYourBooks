import { existsSync } from 'node:fs';

/**
 * Pick a chromium binary:
 *   1. `PLAYWRIGHT_CHROMIUM_PATH` env (set by CI or devs with their own copy).
 *   2. A known local cache path — works on the primary dev box without extra
 *      setup.
 *   3. Otherwise undefined: let Playwright use whichever browser
 *      `playwright install` brought down.
 *
 * Shared by playwright.config.ts and the global-setup warmup so they can't
 * disagree about which binary to launch.
 */
const LOCAL_DEV_CHROMIUM = '/home/jon/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

export function resolveChromiumPath(): string | undefined {
  return (
    process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    (existsSync(LOCAL_DEV_CHROMIUM) ? LOCAL_DEV_CHROMIUM : undefined)
  );
}
