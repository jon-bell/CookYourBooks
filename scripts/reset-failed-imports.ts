// deno run --allow-env --allow-read --allow-net scripts/reset-failed-imports.ts
//
// Reset every OCR_FAILED item back to PENDING so the worker re-tries
// them. Clears attempts + last_error so the retry budget restarts.
// Service-role only. Prints the items it touched.
//
// Optional flag: --batch=<uuid> scopes to one batch.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';

async function loadEnv(): Promise<Record<string, string>> {
  const candidates = [
    new URL('../apps/web/.env.local.prod', import.meta.url),
    new URL('../supabase/.env.prod', import.meta.url),
  ];
  for (const p of candidates) {
    try {
      const text = await Deno.readTextFile(p);
      const out: Record<string, string> = {};
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      }
      return out;
    } catch {
      /* try next */
    }
  }
  console.error('No prod env file found.');
  Deno.exit(2);
}

const env = await loadEnv();
const SUPABASE_URL = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? '';
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing url or service role.');
  Deno.exit(2);
}

let batchFilter: string | undefined;
for (const a of Deno.args) {
  if (a.startsWith('--batch=')) batchFilter = a.slice('--batch='.length);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let q = supabase.from('import_items').select('id, batch_id, page_index, status').eq('status', 'OCR_FAILED');
if (batchFilter) q = q.eq('batch_id', batchFilter);
const { data: failed, error: readErr } = await q;
if (readErr) {
  console.error('read failed', readErr);
  Deno.exit(1);
}
if (!failed || failed.length === 0) {
  console.log('No OCR_FAILED items found.');
  Deno.exit(0);
}

console.log(`Will reset ${failed.length} item(s):`);
console.table(failed);

const ids = failed.map((r: { id: string }) => r.id);
const { error: updErr } = await supabase
  .from('import_items')
  .update({
    status: 'PENDING',
    attempts: 0,
    last_error: null,
    claim_token: null,
    needs_fallback: false,
  })
  .in('id', ids);
if (updErr) {
  console.error('update failed', updErr);
  Deno.exit(1);
}
console.log(`Reset ${ids.length} item(s) to PENDING.`);
console.log('Now kick the worker:');
console.log(`  curl -X POST ${SUPABASE_URL}/functions/v1/import-worker \\`);
console.log(`    -H "Authorization: Bearer <SERVICE_ROLE>" \\`);
console.log(`    -H "Content-Type: application/json" -d '{"batch_id":null}'`);
