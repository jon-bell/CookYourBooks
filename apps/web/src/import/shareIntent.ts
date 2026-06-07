// Mobile "Share to CookYourBooks" bridge.
//
// On a Capacitor native build, another app can share a YouTube/TikTok/
// Instagram link to us. The native share extension (iOS) / ACTION_SEND
// intent filter (Android) is provided by the `send-intent` plugin and
// wakes the host three ways:
//   1. Cold start: `SendIntent.checkSendIntentReceived()` — drains the
//      payload AppDelegate stashed in `ShareStore`.
//   2. Warm start, JS already running: the App plugin's `appUrlOpen`
//      event fires with the raw `cookyourbooks://?…` URL.
//   3. Warm start, in case (2) missed it: the SendIntent plugin fires a
//      window-level `sendIntentReceived` event after AppDelegate
//      populates `ShareStore`. We re-drain via `checkSendIntentReceived`.
//
// We talk to both plugins through the global `Capacitor.Plugins` registry
// rather than importing the npm packages, so the web bundle never has to
// resolve native-only modules — same runtime-feature-detection posture as
// `import/camera.ts`. On the web this is an inert no-op.
//
// Every outcome (success and failure) is delivered to the caller as a
// `ShareIntentOutcome` so the UI can surface a toast instead of failing
// silently. Sentry breadcrumbs are dropped at every transition and
// `captureMessage` fires on the silent-failure paths so the project has
// real diagnostic signal when "share opens app but nothing happens."

import { Sentry } from '../sentry.js';
import { detectVideoPlatform, firstVideoUrl, type VideoPlatform } from './videoPlatform.js';

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

function breadcrumb(message: string, data?: Record<string, unknown>): void {
  Sentry.addBreadcrumb({
    category: 'share-intent',
    level: 'info',
    message,
    data,
  });
  // Mirror to console so a tethered Safari Web Inspector picks it up
  // even on builds where Sentry isn't initialized.
  // eslint-disable-next-line no-console
  console.info('[share-intent]', message, data ?? '');
}

/**
 * Outcome of a single share event. The UI uses `kind` to decide what
 * toast to show (and whether to navigate). `source` identifies which
 * code path delivered it, useful for both Sentry tags and debugging.
 */
export type ShareIntentOutcome =
  | { kind: 'video'; url: string; platform: VideoPlatform; source: string }
  | { kind: 'unsupported_url'; url: string; source: string }
  | { kind: 'no_url'; source: string };

interface ParsedIntent {
  url: string | null;
  platform: VideoPlatform | null;
}

/** Pull a usable URL out of a `SendIntent`/`appUrlOpen` payload, plus
 *  whether it's from a supported video platform. */
function urlFromIntent(payload: unknown): ParsedIntent {
  if (!payload || typeof payload !== 'object') return { url: null, platform: null };
  const obj = payload as Record<string, unknown>;
  const raw = typeof obj.url === 'string' ? obj.url : undefined;
  if (raw) {
    // Custom-scheme deep link → unwrap the embedded `url` query param.
    if (/^cookyourbooks:/i.test(raw)) {
      try {
        const embedded = new URL(raw).searchParams.get('url');
        if (embedded) {
          const video = firstVideoUrl(embedded);
          if (video) return { url: video, platform: detectVideoPlatform(video) };
          if (/^https?:/i.test(embedded)) return { url: embedded, platform: null };
        }
      } catch {
        /* fall through */
      }
    }
    const direct = firstVideoUrl(raw);
    if (direct) return { url: direct, platform: detectVideoPlatform(direct) };
    if (/^https?:/i.test(raw)) return { url: raw, platform: null };
  }
  if (typeof obj.title === 'string') {
    const fromTitle = firstVideoUrl(obj.title);
    if (fromTitle) return { url: fromTitle, platform: detectVideoPlatform(fromTitle) };
    if (/^https?:/i.test(obj.title)) return { url: obj.title, platform: null };
  }
  return { url: null, platform: null };
}

/**
 * Start listening for shared links. Calls `onShare` once per share
 * event with an outcome — success OR failure. Callers always get a
 * signal, even for unsupported URLs, so they can show the user a
 * toast instead of failing silently. Returns a cleanup fn. No-op on
 * the web.
 */
export function initShareIntent(onShare: (outcome: ShareIntentOutcome) => void): () => void {
  if (!isNative()) {
    breadcrumb('initShareIntent: not native, no-op');
    return () => {};
  }
  const plugins = capacitor()?.Plugins ?? {};
  const cleanups: Array<() => void> = [];

  breadcrumb('initShareIntent: registering listeners', {
    hasSendIntent: !!plugins.SendIntent,
    hasApp: !!plugins.App,
  });

  const dispatch = (payload: unknown, source: string): void => {
    const { url, platform } = urlFromIntent(payload);
    breadcrumb(`${source}: payload received`, {
      hasUrl: !!url,
      platform,
      rawPayloadKeys:
        payload && typeof payload === 'object' ? Object.keys(payload as object) : [],
    });
    if (url && platform) {
      onShare({ kind: 'video', url, platform, source });
      return;
    }
    if (url) {
      Sentry.captureMessage('share-intent: URL not from supported video platform', {
        level: 'info',
        tags: { source, share_intent: 'unsupported_platform' },
        extra: { shared_url: url },
      });
      onShare({ kind: 'unsupported_url', url, source });
      return;
    }
    if (payload && typeof payload === 'object') {
      // `checkSendIntentReceived` with an empty store resolves with
      // `{ title: '', url: '', type: '', additionalItems: [] }` —
      // that's not a real share event, suppress it.
      const obj = payload as Record<string, unknown>;
      const isEmptyStore = obj.url === '' && obj.title === '' && obj.type === '';
      if (!isEmptyStore) {
        Sentry.captureMessage('share-intent: payload had no extractable URL', {
          level: 'warning',
          tags: { source, share_intent: 'no_url' },
          extra: { payload_keys: Object.keys(obj) },
        });
        onShare({ kind: 'no_url', source });
      }
    }
  };

  // Cold start: AppDelegate populates ShareStore synchronously before
  // the JS bundle boots, so this call either returns the payload or
  // rejects with "No processing needed." once it's been drained.
  const SendIntent = plugins.SendIntent;
  if (SendIntent?.checkSendIntentReceived) {
    breadcrumb('cold-start: calling SendIntent.checkSendIntentReceived');
    void SendIntent.checkSendIntentReceived()
      .then((res: unknown) => {
        breadcrumb('cold-start: SendIntent resolved', { hasResult: !!res });
        dispatch(res, 'cold-start');
      })
      .catch((err: unknown) => {
        // "No processing needed." is expected when nothing was shared —
        // don't flag it. Anything else is worth a breadcrumb.
        const msg = err instanceof Error ? err.message : String(err);
        breadcrumb('cold-start: SendIntent rejected', { error: msg });
      });
  }

  // Warm start path A: Capacitor's URL handler fires `appUrlOpen` for
  // every cookyourbooks:// open, regardless of cold/warm.
  const App = plugins.App;
  if (App?.addListener) {
    const handle = App.addListener('appUrlOpen', (data: unknown) => {
      breadcrumb('appUrlOpen fired', {
        url: data && typeof data === 'object' ? (data as { url?: unknown }).url : undefined,
      });
      dispatch(data, 'appUrlOpen');
    });
    cleanups.push(() => {
      void Promise.resolve(handle)
        .then((h: { remove?: () => void } | undefined) => h?.remove?.())
        .catch(() => {});
    });
  }

  // Warm start path B: AppDelegate posted `triggerSendIntent`, the
  // plugin forwards it as a window event. Re-drain the store so we
  // don't depend on `appUrlOpen` racing the listener registration.
  if (typeof window !== 'undefined' && SendIntent?.checkSendIntentReceived) {
    const onEvent = (): void => {
      breadcrumb('sendIntentReceived window event: re-checking SendIntent');
      void SendIntent.checkSendIntentReceived()
        .then((res: unknown) => dispatch(res, 'sendIntentReceived'))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          breadcrumb('sendIntentReceived: SendIntent rejected', { error: msg });
        });
    };
    window.addEventListener('sendIntentReceived', onEvent);
    cleanups.push(() => window.removeEventListener('sendIntentReceived', onEvent));
  }

  return () => {
    for (const c of cleanups) c();
  };
}
