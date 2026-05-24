// deno run --allow-env --allow-read --allow-net scripts/probe-imports.ts
//
// Read-only diagnostic. Connects to the prod Supabase project with the
// service role key and inspects bulk-OCR queue state: batches, items
// by status, attempts, and what `import_claim_next` would actually
// return right now. No writes.
//
// Credentials come from `supabase/.env.prod` (gitignored) — see the
// note at the bottom of CLAUDE.md or the chat thread.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';

async function loadEnv(): Promise<Record<string, string>> {
  // Read from the user's existing prod env file. Accepts either the
  // new opaque keys (sb_publishable_/sb_secret_) or legacy JWTs.
  const candidates = [
    new URL('../apps/web/.env.local.prod', import.meta.url),
    new URL('../supabase/.env.prod', import.meta.url),
  ];
  let text: string | undefined;
  for (const p of candidates) {
    try {
      text = await Deno.readTextFile(p);
      break;
    } catch {
      /* try next */
    }
  }
  if (!text) {
    console.error('No prod env file found. Create either:');
    console.error('  apps/web/.env.local.prod  (VITE_SUPABASE_URL + SUPABASE_SECRET_KEY)');
    console.error('  supabase/.env.prod         (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
    Deno.exit(2);
  }
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    out[key] = value;
  }
  return out;
}

const env = await loadEnv();
const SUPABASE_URL = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? '';
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Need a project URL and a service-role / secret key.');
  console.error(`SUPABASE_URL=${SUPABASE_URL || '(missing)'}`);
  console.error(`SERVICE_ROLE=${SERVICE_ROLE ? '(present)' : '(missing)'}`);
  Deno.exit(2);
}
console.log(`Probing ${SUPABASE_URL} as ${SERVICE_ROLE.slice(0, 14)}…`);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function banner(title: string) {
  console.log('\n' + '─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

banner('Batches (most recent 10)');
{
  const { data, error } = await supabase
    .from('import_batches')
    .select('id, owner_id, name, status, source_kind, target_collection_id, total_items, recitation_policy, default_provider, default_model, fallback_provider, fallback_model, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(10);
  if (error) {
    console.error('batches read error', error);
  } else {
    console.table(data ?? []);
  }
}

banner('Items: count by status');
{
  const { data, error } = await supabase
    .from('import_items')
    .select('status', { count: 'exact', head: false });
  if (error) {
    console.error('items read error', error);
  } else {
    const counts: Record<string, number> = {};
    for (const row of (data ?? []) as Array<{ status: string }>) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    console.table(counts);
  }
}

banner('Items: most recent 20 (cross-batch)');
{
  const { data, error } = await supabase
    .from('import_items')
    .select('id, batch_id, owner_id, page_index, status, attempts, last_error, claim_token, claim_expires_at, needs_fallback, model_used, updated_at')
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) console.error('items read error', error);
  else console.table(data ?? []);
}

banner('Attempts: most recent 20 (cross-batch)');
{
  const { data, error } = await supabase
    .from('import_item_attempts')
    .select('id, item_id, attempt_no, provider, model, error_kind, error_message, latency_ms, prompt_tokens, completion_tokens, cost_usd_micros, started_at, finished_at')
    .order('started_at', { ascending: false })
    .limit(20);
  if (error) console.error('attempts read error', error);
  else console.table(data ?? []);
}

banner('User OCR keys');
{
  const { data, error } = await supabase
    .from('user_ocr_keys')
    .select('owner_id, provider, key_fingerprint, base_url, rotated_at');
  if (error) console.error('keys read error', error);
  else console.table(data ?? []);
}

banner('Outbox-equivalent: items PENDING that are visible to import_claim_next');
{
  const { data, error } = await supabase
    .from('import_items')
    .select('id, batch_id, owner_id, page_index, status, needs_fallback, claim_expires_at')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: true })
    .limit(20);
  if (error) console.error('pending read error', error);
  else console.table(data ?? []);
}

banner('Dry-run: what would import_claim_next return right now?');
{
  // Use a sentinel worker_id so any rows we accidentally claim can be
  // identified + released. Lease=1s so anything we touch un-claims
  // itself within a second.
  const workerId = `probe:${crypto.randomUUID()}`;
  const { data, error } = await supabase.rpc('import_claim_next', {
    p_worker_id: workerId,
    p_batch_id: null,
    p_lease_seconds: 1,
    p_limit: 8,
  });
  if (error) {
    console.error('import_claim_next error', error);
  } else {
    console.log(`probe worker id: ${workerId}`);
    console.log(`claimed ${(data ?? []).length} row(s)`);
    console.table(data ?? []);
  }
}

banner('Sanity: does ocr_resolve_key exist + work for the known owner?');
{
  const ownerId = '2e8fb126-2e89-4d66-b830-4d44418ced14';
  const { data, error } = await supabase.rpc('ocr_resolve_key', {
    p_owner_id: ownerId,
    p_provider: 'gemini',
  });
  if (error) {
    console.error('ocr_resolve_key error', error);
    console.error('  → if message is "function does not exist", the');
    console.error('    20260524000000_ocr_resolve_key migration is not applied to prod.');
  } else {
    const rows = (data as Array<{ api_key?: string; base_url: string | null }> | null) ?? [];
    if (rows.length === 0) {
      console.log('Returned 0 rows. user_ocr_keys row exists but the join to vault.decrypted_secrets returned nothing — the vault.secrets row may have been deleted out from under it.');
    } else {
      console.log(`Returned ${rows.length} row(s). api_key length=${rows[0].api_key?.length ?? 0}, base_url=${rows[0].base_url}`);
    }
  }
}

banner('Done.');
