import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  // cr-sqlite-wasm bundles a .wasm file that's loaded via `?url`. Vite's
  // default handling works — no extra config needed — but we exclude it from
  // dep-optimization so the wasm ships as a static asset.
  optimizeDeps: {
    exclude: ['@vlcn.io/crsqlite-wasm'],
  },
});
