import * as Sentry from '@sentry/react';
import { init as initSentryCapacitor } from '@sentry/capacitor';

/**
 * Per-surface DSNs. Sentry DSNs are designed to be public — they only
 * authorize event ingest, not read — so it's safe to embed them in
 * the browser bundle. Override either with VITE_SENTRY_DSN (or the
 * surface-specific env var) to point a build at a different project.
 *
 * - Web → cookyourbooks-web (project /2)
 * - Capacitor (iOS + Android) → cookyourbooks-mobile (project /4)
 * - Edge function (Deno) → cookyourbooks-edge (project /3) — wired
 *   from supabase/functions/import-worker/index.ts.
 */
const DSN_WEB =
  'https://b34dd32e79fff3427b0265461fe08ae2@sentry-cyb.work.ripley.cloud/2';
const DSN_CAPACITOR =
  'https://95f056bdf526b045e58cba49100bc71c@sentry-cyb.work.ripley.cloud/4';

/**
 * Build-time release tag. `vite.config.ts` resolves the release
 * (VITE_SENTRY_RELEASE ?? VERCEL_GIT_COMMIT_SHA) and injects it here as
 * VITE_SENTRY_RELEASE via `define`, so this value always matches the
 * release the source maps were uploaded under. Unset locally → events
 * land in the "dev" bucket on the Sentry dashboard.
 */
const RELEASE = (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ?? null;

/**
 * Detect Capacitor at runtime so we can route reports to the right
 * Sentry project without forking the bundle. `Capacitor.getPlatform()`
 * is the official check; we feature-detect to avoid pulling the
 * Capacitor package into pure-web builds.
 */
function detectPlatform(): 'capacitor-ios' | 'capacitor-android' | 'web' {
  const cap = (globalThis as unknown as { Capacitor?: { getPlatform?: () => string } })
    .Capacitor;
  const p = cap?.getPlatform?.();
  if (p === 'ios') return 'capacitor-ios';
  if (p === 'android') return 'capacitor-android';
  return 'web';
}

let initialized = false;
let lastDsn: string | null = null;
let skipReason: string | null = null;

/**
 * Diagnostic snapshot of the Sentry runtime state, surfaced in the
 * sync diagnostics dialog. Lets a user see at a glance whether
 * Sentry is actually wired up and where events would land — saves the
 * "I clicked send and nothing happened" loop where dev-gated builds
 * silently no-op.
 */
export function getSentryStatus(): {
  initialized: boolean;
  dsnHost: string | null;
  release: string | null;
  environment: string;
  platform: 'capacitor-ios' | 'capacitor-android' | 'web';
  skipReason: string | null;
} {
  const platform = detectPlatform();
  let dsnHost: string | null = null;
  if (lastDsn) {
    try {
      dsnHost = new URL(lastDsn).host;
    } catch {
      dsnHost = lastDsn.slice(0, 40);
    }
  }
  return {
    initialized,
    dsnHost,
    release: RELEASE,
    environment: import.meta.env.MODE,
    platform,
    skipReason,
  };
}

/**
 * Initialize Sentry. Called once from `main.tsx` before React renders.
 * Idempotent — safe to call from HMR re-entries.
 *
 * On Capacitor the init goes through `@sentry/capacitor`, which spins
 * up the native iOS/Android SDK (crash reporting, native breadcrumbs,
 * device context like battery + free disk + native OS version) and
 * also runs `@sentry/react`'s init as a sibling so JS errors still
 * flow through the React-aware ErrorBoundary + replay integrations.
 * On the web the same react init runs directly.
 */
export function initSentry(): void {
  if (initialized) return;
  const platform = detectPlatform();
  const isCapacitor = platform !== 'web';

  const dsn = isCapacitor
    ? ((import.meta.env.VITE_SENTRY_DSN_CAPACITOR as string | undefined) ?? DSN_CAPACITOR)
    : ((import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? DSN_WEB);
  if (!dsn) {
    skipReason = 'no DSN configured (set VITE_SENTRY_DSN or VITE_SENTRY_DSN_CAPACITOR)';
    return;
  }

  // Opt-out hatch. Useful for e2e / load-test runs that shouldn't ship
  // synthetic events. Anything truthy disables; default is enabled.
  if ((import.meta.env.VITE_SENTRY_DISABLE as string | undefined) === '1') {
    skipReason = 'VITE_SENTRY_DISABLE=1';
    return;
  }

  // We used to gate dev builds off (`enabled: PROD || ENABLE_DEV=1`)
  // so `pnpm dev` runs didn't pollute prod Sentry. That made the
  // "send logs" button silently no-op for anyone actively testing
  // Sentry against a local build — exactly when you want it to work.
  // Dev/preview builds now ingest like any other, tagged with
  // `environment: import.meta.env.MODE` (`development` locally,
  // `production` on Vercel builds). Filter on that tag in the Sentry
  // UI if dev events show up where you don't want them.

  initialized = true;
  lastDsn = dsn;
  const commonOptions: Sentry.BrowserOptions = {
    dsn,
    release: RELEASE ?? undefined,
    environment: import.meta.env.MODE,
    integrations: [
      Sentry.browserTracingIntegration(),
      // Replay only fires when an unhandled error is captured (see
      // sample rates below). When it does, every text node and form
      // input is masked, and <img>/<video>/<canvas>/<svg> is blocked,
      // so recipe content and photos never reach Sentry.
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    initialScope: {
      tags: { platform },
    },
    sendDefaultPii: false,
    beforeBreadcrumb(crumb) {
      if (crumb.category === 'fetch' || crumb.category === 'xhr') {
        if (crumb.data) {
          delete (crumb.data as Record<string, unknown>).request_body_size;
          delete (crumb.data as Record<string, unknown>).response_body_size;
          delete (crumb.data as Record<string, unknown>).body;
        }
      }
      return crumb;
    },
  };

  if (isCapacitor) {
    // @sentry/capacitor bridges to the native @sentry/cocoa /
    // @sentry/android SDKs. Pass the React SDK's init as the sibling
    // so JS layers (ErrorBoundary, browser tracing, replay) still
    // initialize alongside the native bridge.
    initSentryCapacitor(commonOptions, Sentry.init);
  } else {
    Sentry.init(commonOptions);
  }
}

/**
 * Tag the current user on every subsequent event. Called from
 * AuthProvider whenever the session changes. We send the user ID
 * (a UUID — opaque) and never the email; email lives only in the
 * auth provider for password resets. setUser via @sentry/react works
 * on Capacitor too — both SDKs share one hub.
 */
export function setSentryUser(userId: string | null): void {
  if (!initialized) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/** Re-export for places that need to capture manually. */
export { Sentry };
