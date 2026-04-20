import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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

  return {
    plugins: [react()],
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
    },
  };
});
