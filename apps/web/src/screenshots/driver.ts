// App Store screenshot driver. Compiled in ONLY when the build sets
// `VITE_SCREENSHOT_CONTROL_URL` (see main.tsx — the dynamic import sits behind
// a static env check, so production bundles don't contain this module).
//
// The host orchestrator (`scripts/ios-screenshots/capture.mjs`) runs a tiny
// HTTP server on the Mac and boots a simulator; the simulator shares the
// host's loopback, so the app can reach it at 127.0.0.1. The protocol:
//
//   GET  /script → { email, password, steps: [{ name, path, settleMs? }] }
//   POST /shot   { name }       → host runs `simctl io screenshot`, then replies
//   POST /log    { msg }        → echoed to the CI log
//   POST /done   { ok, error? } → host moves on to the next device
//
// Credentials come from the host at runtime (CI secrets), never from the
// bundle. Requests go through the native CapacitorHttp plugin when present:
// a WKWebView `fetch` from capacitor://localhost to http://127.0.0.1 is at the
// mercy of mixed-content rules, while native URLSession only needs the ATS
// local-networking exemption the orchestrator adds to the screenshot build.

import { supabase } from '../supabase.js';

export interface ScreenshotStep {
  /** File name stem, e.g. "01-recipes". */
  name: string;
  /** Route to show. `{recipe}` expands to a recipe from the gallery (one with
   *  a cover image when possible). */
  path: string;
  /** Extra settle time after the page reports ready. */
  settleMs?: number;
}

interface ScreenshotScript {
  email: string;
  password: string;
  steps: ScreenshotStep[];
}

interface HttpResponse {
  status: number;
  data: unknown;
}

interface CapacitorHttpPlugin {
  request(opts: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    data?: unknown;
    readTimeout?: number;
  }): Promise<HttpResponse>;
}

function nativeHttp(): CapacitorHttpPlugin | undefined {
  const cap = (
    globalThis as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        Plugins?: { CapacitorHttp?: CapacitorHttpPlugin };
      };
    }
  ).Capacitor;
  return cap?.isNativePlatform?.() ? cap.Plugins?.CapacitorHttp : undefined;
}

async function call(base: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const url = `${base}${path}`;
  const http = nativeHttp();
  if (http) {
    const res = await http.request({
      url,
      method,
      headers: { 'Content-Type': 'application/json' },
      data: body,
      // /shot blocks while the host captures; give it room.
      readTimeout: 60_000,
    });
    if (res.status >= 400) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return typeof res.data === 'string' ? (JSON.parse(res.data || 'null') as unknown) : res.data;
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred` holds; on timeout, log and carry on (a slightly
 *  unsettled screenshot beats no screenshot). */
async function waitUntil(
  label: string,
  pred: () => boolean,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(250);
  }
  log(`timed out waiting for ${label}`);
  return false;
}

function navigate(path: string) {
  // BrowserRouter listens for popstate; pushState alone doesn't notify it.
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function syncIdle(): boolean {
  const el = document.querySelector('[data-sync-state]');
  return el?.getAttribute('data-sync-state') === 'idle';
}

function pageSettled(): boolean {
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

const RECIPE_HREF = /^\/collections\/[^/]+\/recipes\/[^/]+$/;

async function resolveRecipePath(log: (msg: string) => void): Promise<string | undefined> {
  navigate('/');
  await waitUntil('recipe gallery', () => pageSettled() && !!findRecipeLink(), 30_000, log);
  return findRecipeLink();
}

function findRecipeLink(): string | undefined {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('main a[href]')).filter(
    (a) => RECIPE_HREF.test(a.getAttribute('href') ?? ''),
  );
  const withCover = links.find((a) => a.querySelector('img'));
  return (withCover ?? links[0])?.getAttribute('href') ?? undefined;
}

export async function runScreenshotDriver(base: string): Promise<void> {
  // Everything reports to the host's CI log — console output from the
  // WKWebView isn't visible there.
  const log = (msg: string) => {
    void call(base, 'POST', '/log', { msg }).catch(() => undefined);
  };
  try {
    const script = (await call(base, 'GET', '/script')) as ScreenshotScript;
    log(`script: ${script.steps.length} steps`);

    const { data: existing } = await supabase.auth.getSession();
    if (!existing.session) {
      const { error } = await supabase.auth.signInWithPassword({
        email: script.email,
        password: script.password,
      });
      if (error) throw new Error(`sign-in failed: ${error.message}`);
      log('signed in');
    }
    navigate('/');
    // First sync on a fresh simulator pulls the whole demo library.
    await waitUntil('first sync', syncIdle, 180_000, log);
    log('synced');

    let recipePath: string | undefined;
    for (const step of script.steps) {
      let path = step.path;
      if (path.includes('{recipe}')) {
        recipePath ??= await resolveRecipePath(log);
        if (!recipePath) {
          log(`skip ${step.name}: no recipe in the gallery`);
          continue;
        }
        path = path.replace('{recipe}', recipePath);
      }
      navigate(path);
      await sleep(300);
      await waitUntil(`${step.name} settle`, () => pageSettled() && syncIdle(), 45_000, log);
      window.scrollTo(0, 0);
      await sleep(step.settleMs ?? 1200);
      await call(base, 'POST', '/shot', { name: step.name, path });
      log(`shot ${step.name} (${path})`);
    }
    await call(base, 'POST', '/done', { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await call(base, 'POST', '/done', { ok: false, error: message }).catch(() => undefined);
  }
}
