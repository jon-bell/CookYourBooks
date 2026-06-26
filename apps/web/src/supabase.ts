import type { Database } from '@cookyourbooks/db';
import { createClient } from '@supabase/supabase-js';

import { isMetering, recordTransfer } from './local/transferMeter.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Surface misconfiguration loudly — the app is useless without it.
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see apps/web/.env.local).',
  );
}

/** Approximate the serialized byte size of a request body without consuming it. */
function requestBodyBytes(body: BodyInit | null | undefined): number {
  if (body == null) return 0;
  if (typeof body === 'string') return body.length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  // URLSearchParams / FormData / ReadableStream: not worth the cost to size.
  return 0;
}

// Wrap the global fetch so the data-transfer meter (transferMeter.ts) sees
// every Supabase request — PostgREST, edge functions, storage, auth —
// while a sync cycle's measurement window is open. No-op cost when no
// window is open: we only read headers we already have, never clone or
// drain the body. Response down-bytes come from Content-Length (the
// on-the-wire, already-gzipped size); absent headers contribute 0.
const baseFetch: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);
const meteredFetch: typeof fetch = async (input, init) => {
  if (!isMetering()) return baseFetch(input, init);
  const up = requestBodyBytes(init?.body ?? (input instanceof Request ? null : undefined));
  const res = await baseFetch(input, init);
  const len = res.headers.get('content-length');
  recordTransfer(len ? Number(len) || 0 : 0, up);
  return res;
};

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  global: { fetch: meteredFetch },
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
