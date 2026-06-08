// deno run --allow-env --allow-read --allow-net --allow-sys --allow-ffi \
//   --allow-write --node-modules-dir=auto scripts/embed-nutrition-foods.ts
//
// (--allow-ffi: @huggingface/transformers loads the native
//  onnxruntime-node binding for inference in Deno. --allow-write: it
//  caches the downloaded gte-small weights under node_modules.)
//
// One-time / occasional backfill of gte-small embeddings for the GENERIC
// USDA food tiers (Foundation, SR Legacy, Survey), powering the semantic
// nutrition fallback (search_nutrition_foods_semantic, migration
// 20260608000500). Branded is intentionally NOT embedded — it's excluded
// from auto-match.
//
// Uses @huggingface/transformers (Xenova/gte-small, q8, mean-pool +
// normalize) — the SAME loader and settings as the browser
// (apps/web/src/search/embedder.ts), so these document vectors are
// cosine-comparable with the query vectors the nutrition edge function
// produces at runtime via Supabase.ai.Session('gte-small').
//
// Reads SUPABASE_URL + service-role key from apps/web/.env.local.prod
// (same pattern as load-usda-foods.ts). Idempotent: rows already
// embedded under the current model are skipped unless --refresh.
//
//   --batch     rows per upsert (default 500)
//   --limit     stop after N foods (debug)
//   --refresh   re-embed even if a vector already exists
//   --env-file  override credentials file path

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import { pipeline } from 'npm:@huggingface/transformers@3.7.0';

const EMBEDDING_MODEL_ID = 'Xenova/gte-small';
const EMBEDDING_STORED_MODEL = 'gte-small';
const EMBEDDING_DIM = 384;
const GENERIC_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];

async function loadEnv(envFileOverride?: string): Promise<Record<string, string>> {
  const candidates = envFileOverride
    ? [new URL('file://' + envFileOverride)]
    : [
        new URL('../apps/web/.env.local.prod', import.meta.url),
        new URL('../supabase/.env.prod', import.meta.url),
      ];
  for (const p of candidates) {
    try {
      const text = await Deno.readTextFile(p);
      console.error(`(env from ${p.pathname})`);
      const env: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
      }
      return env;
    } catch { /* try next */ }
  }
  throw new Error(`No env file found. Tried: ${candidates.map((c) => c.pathname).join(', ')}`);
}

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
function flag(name: string): boolean {
  return Deno.args.includes(`--${name}`);
}

function toVectorLiteral(v: Float32Array | number[]): string {
  return `[${Array.from(v).join(',')}]`;
}

async function fetchExistingKeys(sb: SupabaseClient): Promise<Set<string>> {
  const keys = new Set<string>();
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await sb
      .from('nutrition_food_embeddings')
      .select('source, source_id')
      .eq('model', EMBEDDING_STORED_MODEL)
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as { source: string; source_id: string }[]) {
      keys.add(`${r.source}|${r.source_id}`);
    }
    from += page;
    if (data.length < page) break;
  }
  return keys;
}

async function main() {
  const batch = Number(arg('batch') ?? '500');
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const refresh = flag('refresh');
  const env = await loadEnv(arg('env-file'));
  const URL_ = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? env.SERVICE_ROLE_KEY ?? '';
  if (!URL_ || !KEY) throw new Error('Missing SUPABASE_URL or service-role key in env file');
  const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const skip = refresh ? new Set<string>() : await fetchExistingKeys(sb);
  console.error(`${skip.size} already embedded (will skip; --refresh to redo)`);

  console.error(`loading ${EMBEDDING_MODEL_ID} (q8)…`);
  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: 'q8' });

  let processed = 0;
  let upserted = 0;
  let pending: { source: string; source_id: string; embedding: string; model: string }[] = [];

  async function flushPending() {
    if (pending.length === 0) return;
    const { error } = await sb.from('nutrition_food_embeddings').upsert(pending, {
      onConflict: 'source,source_id',
    });
    if (error) throw error;
    upserted += pending.length;
    pending = [];
    console.error(`  upserted ${upserted}…`);
  }

  // Page through the generic master rows by primary key for a stable
  // cursor (source_id ordering within the source).
  let from = 0;
  const page = 1000;
  outer: while (true) {
    const { data, error } = await sb
      .from('nutrition_foods_master')
      .select('source, source_id, description')
      .in('data_type', GENERIC_TYPES)
      .order('source', { ascending: true })
      .order('source_id', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as { source: string; source_id: string; description: string }[]) {
      if (limit != null && processed >= limit) break outer;
      processed += 1;
      const key = `${r.source}|${r.source_id}`;
      if (skip.has(key)) continue;
      const out = await extractor(r.description ?? '', { pooling: 'mean', normalize: true });
      const arr = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
      if (arr.length !== EMBEDDING_DIM) {
        throw new Error(`embedder returned ${arr.length} dims for "${r.description}"`);
      }
      pending.push({
        source: r.source,
        source_id: r.source_id,
        embedding: toVectorLiteral(arr),
        model: EMBEDDING_STORED_MODEL,
      });
      if (pending.length >= batch) await flushPending();
    }
    from += page;
    if (data.length < page) break;
  }
  await flushPending();
  console.error(`done: scanned ${processed}, embedded ${upserted}`);
}

await main();
