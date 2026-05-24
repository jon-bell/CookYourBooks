// deno run --allow-env --allow-read --allow-net --allow-write scripts/dump-raw.ts <item-id>
//
// Pull the raw LLM response blobs for an item's most recent attempts
// and write them to /tmp so we can eyeball what the model actually
// emitted.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';

async function loadEnv(): Promise<Record<string, string>> {
  const text = await Deno.readTextFile(new URL('../apps/web/.env.local.prod', import.meta.url));
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const env = await loadEnv();
const SUPABASE_URL = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? '';

const itemId = Deno.args[0];
if (!itemId) {
  console.error('Usage: dump-raw.ts <item-id>');
  Deno.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: attempts, error } = await supabase
  .from('import_item_attempts')
  .select('id, attempt_no, raw_response_path, error_kind, error_message')
  .eq('item_id', itemId)
  .order('attempt_no', { ascending: false })
  .limit(5);
if (error) {
  console.error('attempts read failed', error);
  Deno.exit(1);
}
if (!attempts || attempts.length === 0) {
  console.error('No attempts for that item.');
  Deno.exit(1);
}

for (const a of attempts as Array<{ id: string; attempt_no: number; raw_response_path: string | null; error_kind: string; error_message: string | null }>) {
  console.log(`Attempt ${a.attempt_no}: kind=${a.error_kind} path=${a.raw_response_path}`);
  if (!a.raw_response_path) continue;
  const { data, error: dlErr } = await supabase.storage.from('imports').download(a.raw_response_path);
  if (dlErr || !data) {
    console.error('  download failed', dlErr);
    continue;
  }
  const text = await data.text();
  const out = `/tmp/raw-${itemId.slice(0, 8)}-att${a.attempt_no}.txt`;
  await Deno.writeTextFile(out, text);
  console.log(`  wrote ${text.length} bytes → ${out}`);
}
