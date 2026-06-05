// Mobile "Share to CookYourBooks" bridge.
//
// On a Capacitor native build, another app can share a YouTube/TikTok/
// Instagram link to us. The native share extension (iOS) / ACTION_SEND
// intent filter (Android) is provided by the `send-intent` plugin and
// wakes the app via the `@capacitor/app` `appUrlOpen` event; cold starts
// are read with `SendIntent.checkSendIntentReceived()`.
//
// We talk to both plugins through the global `Capacitor.Plugins` registry
// rather than importing the npm packages, so the web bundle never has to
// resolve native-only modules — same runtime-feature-detection posture as
// `import/camera.ts`. On the web this is an inert no-op.

import { firstVideoUrl } from './videoPlatform.js';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  // deno-lint-ignore no-explicit-any
  Plugins?: Record<string, any>;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

function isNative(): boolean {
  return !!capacitor()?.isNativePlatform?.();
}

/** Pull a usable video URL out of a `SendIntent`/`appUrlOpen` payload. */
function urlFromIntent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  // SendIntent: { title, url, type }. appUrlOpen: { url } where url may be
  // our custom scheme cookyourbooks://share?url=<encoded>.
  const raw = typeof obj.url === 'string' ? obj.url : undefined;
  if (raw) {
    // Custom-scheme deep link → unwrap the embedded `url` param.
    if (/^cookyourbooks:/i.test(raw)) {
      try {
        const embedded = new URL(raw).searchParams.get('url');
        if (embedded) return firstVideoUrl(embedded);
      } catch {
        /* fall through */
      }
    }
    const direct = firstVideoUrl(raw);
    if (direct) return direct;
  }
  if (typeof obj.title === 'string') return firstVideoUrl(obj.title);
  return null;
}

/**
 * Start listening for shared links. Calls `onUrl` with each supported
 * video URL received (cold start + while running). Returns a cleanup fn.
 * No-op on the web.
 */
export function initShareIntent(onUrl: (url: string) => void): () => void {
  if (!isNative()) return () => {};
  const plugins = capacitor()?.Plugins ?? {};
  const cleanups: Array<() => void> = [];

  // Cold start: the app was launched by a share.
  const SendIntent = plugins.SendIntent;
  if (SendIntent?.checkSendIntentReceived) {
    void SendIntent.checkSendIntentReceived()
      .then((res: unknown) => {
        const url = urlFromIntent(res);
        if (url) onUrl(url);
      })
      .catch(() => {
        /* nothing was shared / plugin unavailable */
      });
  }

  // Warm start: a share arrived while the app was already open.
  const App = plugins.App;
  if (App?.addListener) {
    const handle = App.addListener('appUrlOpen', (data: unknown) => {
      const url = urlFromIntent(data);
      if (url) onUrl(url);
    });
    cleanups.push(() => {
      void Promise.resolve(handle)
        .then((h: { remove?: () => void } | undefined) => h?.remove?.())
        .catch(() => {});
    });
  }

  return () => {
    for (const c of cleanups) c();
  };
}
