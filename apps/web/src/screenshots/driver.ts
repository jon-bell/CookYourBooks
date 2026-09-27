// App Store screenshot driver. Compiled in ONLY when the build sets
// `VITE_SCREENSHOT_CONTROL_URL` (see main.tsx — the dynamic import sits behind
// a static env check, so production bundles don't contain this module).
//
// The host orchestrator (`scripts/ios-screenshots/capture.mjs`) runs a tiny
// HTTP server on the Mac and boots a simulator; the simulator shares the
// host's loopback, so the app can reach it at 127.0.0.1. The protocol:
//
//   GET  /script        → { email, password, steps: ScreenshotStep[] }
//   GET  /corpus/<book> → a demo-content book: metadata + recipe page paths
//   GET  /asset/<path>  → one corpus file (a page image)
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
import { navigate, pageSettled, sleep, syncIdle, waitUntil } from './dom.js';
import { type ImportContext, runImportAction } from './importScenario.js';

/**
 * One step of the script (scripts/ios-screenshots/steps.json). Either shows a
 * route (`path`) or performs an import-flow action (`do`); `shot` names the
 * screenshot taken once the page settles. A step without `shot` just acts.
 */
export interface ScreenshotStep {
  /** Screenshot file stem, e.g. "01-recipes". */
  shot?: string;
  /** Route to show. `{recipe}` expands to a recipe from the gallery (one with
   *  a cover image when possible). */
  path?: string;
  /** Import-flow action — see importScenario.ts. */
  do?: 'import-select' | 'import-start' | 'import-wait' | 'import-item' | 'import-recipe';
  /** import-select: corpus book id, and optionally which recipe folders. */
  book?: string;
  recipes?: string[];
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
    responseType?: 'json' | 'text' | 'blob';
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

/** The host's control channel. */
export interface Host {
  call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
  /** Fetch a binary asset (a corpus page image). */
  blob(path: string, type: string): Promise<Blob>;
  log: (msg: string) => void;
}

function makeHost(base: string): Host {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
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
  };
  const blob = async (path: string, type: string) => {
    const url = `${base}${path}`;
    const http = nativeHttp();
    if (http) {
      // CapacitorHttp hands binary bodies back base64-encoded.
      const res = await http.request({ url, method: 'GET', responseType: 'blob' });
      if (res.status >= 400) throw new Error(`GET ${path}: HTTP ${res.status}`);
      const bin = atob(String(res.data));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type });
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return new Blob([await res.arrayBuffer()], { type });
  };
  // Everything reports to the host's CI log — console output from the
  // WKWebView isn't visible there.
  const log = (msg: string) => {
    void call('POST', '/log', { msg }).catch(() => undefined);
  };
  return { call, blob, log };
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
  const host = makeHost(base);
  const { log } = host;
  try {
    const script = (await host.call('GET', '/script')) as ScreenshotScript;
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
    const importCtx: ImportContext = {};
    for (const [i, step] of script.steps.entries()) {
      const label = step.shot ?? step.do ?? `step ${i + 1}`;
      if (step.do) {
        const ok = await runImportAction(step, importCtx, host);
        if (!ok) {
          log(`skip ${label}`);
          continue;
        }
      } else if (step.path) {
        let path = step.path;
        if (path.includes('{recipe}')) {
          recipePath ??= await resolveRecipePath(log);
          if (!recipePath) {
            log(`skip ${label}: no recipe in the gallery`);
            continue;
          }
          path = path.replace('{recipe}', recipePath);
        }
        navigate(path);
      }
      if (!step.shot) continue;
      await sleep(300);
      await waitUntil(`${label} settle`, () => pageSettled() && syncIdle(), 45_000, log);
      window.scrollTo(0, 0);
      await sleep(step.settleMs ?? 1200);
      await host.call('POST', '/shot', { name: step.shot });
      log(`shot ${step.shot} (${window.location.pathname})`);
    }
    await host.call('POST', '/done', { ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await host.call('POST', '/done', { ok: false, error: message }).catch(() => undefined);
  }
}
