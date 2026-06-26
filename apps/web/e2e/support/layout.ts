import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Assert nothing overflows the viewport horizontally — the canonical
 * "fits on the phone" check.
 *
 * Page scope: `documentElement.scrollWidth` must not exceed the visual
 * viewport width. Element scope: that element's own content box must not
 * overflow (`scrollWidth <= clientWidth`) — use it for a region that is
 * *meant* to scroll its inner content (e.g. a dialog with wide tables)
 * but must not push the page, or its own frame, wider than the screen.
 *
 * `tolerance` (default 1px) absorbs sub-pixel rounding under
 * `deviceScaleFactor > 1`; a real horizontal scrollbar overflows by far
 * more than a pixel, so this stays sensitive to genuine regressions.
 */
export async function expectNoHorizontalOverflow(
  target: Page | Locator,
  opts: { tolerance?: number } = {},
): Promise<void> {
  const tolerance = opts.tolerance ?? 1;
  // Page has `goto`; Locator does not — cheap, reliable discriminator.
  if ('goto' in target) {
    const { scrollWidth, innerWidth } = await target.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      scrollWidth,
      `document overflows horizontally: scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`,
    ).toBeLessThanOrEqual(innerWidth + tolerance);
    return;
  }
  const { scrollWidth, clientWidth } = await target.evaluate((node) => ({
    scrollWidth: (node as HTMLElement).scrollWidth,
    clientWidth: (node as HTMLElement).clientWidth,
  }));
  expect(
    scrollWidth,
    `element overflows horizontally: scrollWidth=${scrollWidth} > clientWidth=${clientWidth}`,
  ).toBeLessThanOrEqual(clientWidth + tolerance);
}
