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
import type { VideoPlatform } from './videoPlatform.js';
import { parseShareIntent, type SharedFileKind } from './shareUrlParse.js';

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
  // platform 'website' is any non-social http(s) recipe link.
  | { kind: 'import'; url: string; platform: VideoPlatform | 'website'; source: string }
  // A shared file (PDF / image) sitting in the app group container. `fileUrl`
  // is a `file://` path; the bytes are read on demand via `import/sharedFile.ts`.
  | { kind: 'import_file'; fileUrl: string; fileKind: SharedFileKind; name: string | null; source: string }
  | { kind: 'no_url'; source: string };

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
    const parsed = parseShareIntent(payload);
    breadcrumb(`${source}: payload received`, {
      kind: parsed.kind,
      platform: parsed.kind === 'url' ? parsed.platform : undefined,
      fileKind: parsed.kind === 'file' ? parsed.fileKind : undefined,
      rawPayloadKeys:
        payload && typeof payload === 'object' ? Object.keys(payload as object) : [],
    });
    if (parsed.kind === 'url') {
      // Social platform when detected, otherwise a generic recipe website —
      // both import through the same link flow.
      onShare({ kind: 'import', url: parsed.url, platform: parsed.platform ?? 'website', source });
      return;
    }
    if (parsed.kind === 'file') {
      // PDF / image attachment — the page reads the bytes from the app group.
      onShare({
        kind: 'import_file',
        fileUrl: parsed.fileUrl,
        fileKind: parsed.fileKind,
        name: parsed.name,
        source,
      });
      return;
    }
    if (payload && typeof payload === 'object') {
      // `checkSendIntentReceived` with an empty store resolves with
      // `{ title: '', url: '', type: '', additionalItems: [] }` —
      // that's not a real share event, suppress it.
      const obj = payload as Record<string, unknown>;
      const isEmptyStore = obj.url === '' && obj.title === '' && obj.type === '';
      if (!isEmptyStore) {
        const trunc = (v: unknown): string | null =>
          typeof v === 'string' ? v.slice(0, 500) : null;
        Sentry.captureMessage('share-intent: payload had no extractable URL', {
          level: 'warning',
          tags: { source, share_intent: 'no_url' },
          // Capture the actual field values (not just keys) so we can finally
          // see what hosts that don't include a parseable link — notably the
          // NYT Cooking in-app share — actually send. Recipe links/titles are
          // non-PII; truncated defensively.
          extra: {
            payload_keys: Object.keys(obj),
            raw_url: trunc(obj.url),
            raw_title: trunc(obj.title),
            raw_description: trunc(obj.description),
            raw_type: trunc(obj.type),
          },
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
