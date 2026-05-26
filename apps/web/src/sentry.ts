import * as Sentry from '@sentry/react';

/**
 * Self-hosted Sentry default. Sentry DSNs are designed to be public —
 * they only authorize event ingest, not read, so it's safe to embed in
 * the browser bundle. Overridable via VITE_SENTRY_DSN if you want to
 * point a build at a different project (e.g. staging vs prod).
 */
const DEFAULT_DSN =
  'https://b34dd32e79fff3427b0265461fe08ae2@sentry-cyb.work.ripley.cloud/2';

const DSN = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? DEFAULT_DSN;

/**
 * Build-time release tag. Vercel exposes VERCEL_GIT_COMMIT_SHA;
 * locally we fall back to the package version + "-dev" so every dev
 * session lands in a "dev" bucket on the Sentry dashboard.
 */
const RELEASE =
  (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ??
  ((import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA as string | undefined) ?? null);

/**
 * Detect Capacitor at runtime so we can tag iOS reports separately
 * without forking the bundle. `Capacitor.isNativePlatform()` is the
 * official check; we feature-detect to avoid importing the package
 * just for this.
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

/**
 * Initialize Sentry. Called once from `main.tsx` before React renders.
 * Idempotent — safe to call from HMR re-entries.
 */
export function initSentry(): void {
  if (initialized) return;
  if (!DSN) return;
  initialized = true;
  const platform = detectPlatform();
  Sentry.init({
    dsn: DSN,
    release: RELEASE ?? undefined,
    environment: import.meta.env.MODE,
    // Don't keep events from local dev unless explicitly opted in.
    // `import.meta.env.PROD` is true only for production builds.
    enabled:
      import.meta.env.PROD ||
      (import.meta.env.VITE_SENTRY_ENABLE_DEV as string | undefined) === '1',
    integrations: [
      Sentry.browserTracingIntegration(),
      // Replay only fires when an unhandled error is captured (see
      // sample rates below). When it does, every text node and form
      // input is masked, and <img>/<video>/<canvas>/<svg> is blocked,
      // so recipe content and photos never reach Sentry. This is the
      // privacy-conservative default; loosen per-element with the
      // `data-sentry-mask=false` attribute when you want a chunk of
      // UI to be visible in the replay (e.g. nav chrome).
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    // 10% of all transactions get a perf trace. Cheap on a small
    // user base; bump down if event ingest gets noisy.
    tracesSampleRate: 0.1,
    // No baseline session recording — replay only when something
    // breaks. 100% on errors so we always see the lead-up.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    initialScope: {
      tags: { platform },
    },
    // PII scrubber. Sentry's own sendDefaultPii=false handles most
    // bookkeeping, but app-specific data can sneak in via breadcrumb
    // URLs or fetch payloads. Drop request/response bodies entirely
    // for any breadcrumb that came from a Supabase call — recipe
    // bodies, OCR drafts, and shopping lists all flow through these.
    sendDefaultPii: false,
    beforeBreadcrumb(crumb) {
      if (crumb.category === 'fetch' || crumb.category === 'xhr') {
        // Strip request body/response body — keep url + status only.
        if (crumb.data) {
          delete (crumb.data as Record<string, unknown>).request_body_size;
          delete (crumb.data as Record<string, unknown>).response_body_size;
          delete (crumb.data as Record<string, unknown>).body;
        }
      }
      return crumb;
    },
  });
}

/**
 * Tag the current user on every subsequent event. Called from
 * AuthProvider whenever the session changes. We send the user ID
 * (a UUID — opaque) and never the email; email lives only in the
 * auth provider for password resets.
 */
export function setSentryUser(userId: string | null): void {
  if (!initialized) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/** Re-export for places that need to capture manually. */
export { Sentry };
