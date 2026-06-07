import type { ViewportSize } from '@playwright/test';

/**
 * iPhone 17 (2025) logical viewport: 402×874 CSS points (matches the
 * iPhone 16/17 Pro family). Playwright's bundled device list has no
 * 'iPhone 17' descriptor, so we pin the numbers here and reuse them
 * everywhere — the `mobile` Playwright project and any per-file
 * `test.use(...)` override both import this, so they can't drift.
 */
export const IPHONE_17: ViewportSize = { width: 402, height: 874 };

/**
 * `use`-shaped block for the mobile project / per-file override. We pin
 * viewport + hasTouch + deviceScaleFactor but deliberately NOT
 * `isMobile: true` — that flag is Chromium-only and changes the UA +
 * viewport-meta handling in ways unrelated to the CSS-width regressions
 * we're guarding. `hasTouch` is enough to exercise tap / pointer
 * affordances (dnd-kit's PointerSensor, the camera shutter, etc.).
 */
export const IPHONE_17_USE = {
  viewport: IPHONE_17,
  deviceScaleFactor: 3,
  hasTouch: true,
} as const;
