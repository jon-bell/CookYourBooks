// DOM helpers shared by the screenshot driver and its import scenario.

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` holds; on timeout, log and carry on (a slightly
 *  unsettled screenshot beats no screenshot). */
export async function waitUntil(
  label: string,
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  log: (msg: string) => void,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(intervalMs);
  }
  log(`timed out waiting for ${label}`);
  return false;
}

export function navigate(path: string) {
  // BrowserRouter listens for popstate; pushState alone doesn't notify it.
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function syncIdle(): boolean {
  const el = document.querySelector('[data-sync-state]');
  return el?.getAttribute('data-sync-state') === 'idle';
}

export function pageSettled(): boolean {
  if (document.querySelector('[data-testid^="loading-"]')) return false;
  // Every image in (or near) the viewport has finished decoding.
  const vh = window.innerHeight * 1.2;
  for (const img of Array.from(document.images)) {
    const r = img.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
    if (!img.complete) return false;
  }
  return true;
}
