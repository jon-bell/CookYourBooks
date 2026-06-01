import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';

// Vite only exposes `VITE_*`-prefixed env vars to `import.meta.env`.
// Vercel's Supabase integration ships unprefixed names (`SUPABASE_URL`,
// `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`). Rather than asking
// every dev / CI / hosting surface to re-set with the `VITE_` prefix,
// resolve both here and `define`-inline the result. `SUPABASE_SECRET_KEY`
// / `SUPABASE_JWT_SECRET` / `SERVICE_ROLE_KEY` are deliberately NOT read
// — those would be catastrophic to ship in a public bundle.
export default defineConfig(({ mode }) => {
  // `loadEnv` reads from `.env*` files in cwd; Vercel / CI put vars
  // directly in `process.env`, so merge both with process.env winning.
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
  const supabaseUrl = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL ?? '';
  const supabaseAnonKey =
    env.VITE_SUPABASE_ANON_KEY ??
    env.SUPABASE_PUBLISHABLE_KEY ??
    env.SUPABASE_ANON_KEY ??
    '';

  // Source-map upload to self-hosted Sentry. Skip the plugin unless
  // SENTRY_AUTH_TOKEN is set in the build env so dev builds don't
  // try to upload (and don't fail when the token is absent).
  const sentryAuthToken = env.SENTRY_AUTH_TOKEN ?? '';
  const sentryUrl = env.SENTRY_URL ?? 'https://sentry-cyb.work.ripley.cloud';
  const sentryOrg = env.SENTRY_ORG ?? 'cyb';
  // Web events report to the `cyb-react` project (DSN …/2). The mobile
  // CI build overrides SENTRY_PROJECT to `cyb-capacitor` so the bundle
  // shipped in the IPA uploads its maps to the project its events go to.
  const sentryProject = env.SENTRY_PROJECT ?? 'cyb-react';
  const sentryRelease =
    env.VITE_SENTRY_RELEASE ?? env.VERCEL_GIT_COMMIT_SHA ?? undefined;

  return {
    plugins: [
      react(),
      ...(sentryAuthToken
        ? [
            sentryVitePlugin({
              authToken: sentryAuthToken,
              url: sentryUrl,
              org: sentryOrg,
              project: sentryProject,
              release: sentryRelease ? { name: sentryRelease } : undefined,
              sourcemaps: {
                assets: './dist/**',
                // Delete the .map files after they're uploaded so the
                // generated source maps don't ship publicly to Vercel
                // (Debug IDs already let Sentry symbolicate without the
                // maps being web-reachable).
                filesToDeleteAfterUpload: ['./dist/**/*.map'],
              },
              // Quiet output on Vercel so build logs stay readable.
              silent: true,
              // Self-hosted Sentry doesn't have an org-level telemetry
              // ping; disable so we don't probe their servers.
              telemetry: false,
            }),
          ]
        : []),
    ],
    build: {
      // Required for source-map upload — Sentry's symbolicator needs
      // the .map files alongside the .js. We delete them post-upload
      // via deleteFilesAfterUpload below if we ever care to.
      sourcemap: true,
    },
    server: {
      port: 5173,
      strictPort: false,
    },
    optimizeDeps: {
      // cr-sqlite-wasm bundles a .wasm file that's loaded via `?url`.
      // Vite's default handling works, but we exclude it from
      // dep-optimization so the wasm ships as a static asset.
      exclude: ['@vlcn.io/crsqlite-wasm'],
    },
    define: {
      // Inline the resolved values as strings at build time so the
      // `import.meta.env.VITE_SUPABASE_*` references in `supabase.ts`
      // work regardless of which of the three name conventions the
      // host platform is using.
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey),
      // Pin the runtime release tag to the SAME value the source-map
      // uploader used above. Vercel only exposes the unprefixed
      // VERCEL_GIT_COMMIT_SHA, which Vite can't surface to
      // import.meta.env on its own — so without this inject, runtime
      // events carried a null release while maps were uploaded under
      // the commit SHA. Only define it when we actually resolved one,
      // so local dev still lands events in the "dev" bucket.
      ...(sentryRelease
        ? { 'import.meta.env.VITE_SENTRY_RELEASE': JSON.stringify(sentryRelease) }
        : {}),
    },
  };
});
