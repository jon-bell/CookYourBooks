import { createClient } from '@supabase/supabase-js';
import type { Database } from '@cookyourbooks/db';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Surface misconfiguration loudly — the app is useless without it.
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see apps/web/.env.local).',
  );
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// Expose the client to E2E tests. The anon key is already in the
// bundle, so this leaks nothing a page-source inspection wouldn't. The
// alternative was `await import('/src/supabase.ts')` inside test bodies,
// which only works against the Vite dev server (the path doesn't exist
// in a production build).
declare global {
  interface Window {
    __cybSupabase?: typeof supabase;
  }
}
if (typeof window !== 'undefined') {
  window.__cybSupabase = supabase;
}
