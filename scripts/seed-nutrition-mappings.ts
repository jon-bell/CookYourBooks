// deno run --allow-env --allow-read --allow-net --allow-sys \
//   --node-modules-dir=auto scripts/seed-nutrition-mappings.ts > /tmp/seed-proposals.tsv
//
// Curation helper for the platform-default nutrition mappings
// (Pillar C). Pulls the most common ingredient names from the
// production recipe corpus, runs each through the SAME term extraction
// the live matcher uses (supabase/functions/nutrition/_ingredientTerms.ts),
// and proposes the best GENERIC USDA food by replicating the v2 ranking
// (tier → calories present → coverage → specificity) in JS against the
// production nutrition_foods_master. The matching here is a baseline for
// human review, not the final word.
//
// Output: a TSV on stdout — one row per ingredient key:
//   key <tab> count <tab> source <tab> source_id <tab> data_type <tab> description
// Review/correct it, then feed the reviewed file to
//   scripts/seed-nutrition-mappings.ts --emit-sql /path/to/reviewed.tsv
// to generate the seed migration body.
//
//   --top N        how many top keys to propose for (default 200)
//   --emit-sql F   skip proposing; print INSERT SQL from reviewed TSV F
//   --env-file F   override credentials file path

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import { extractIngredientTerms } from '../supabase/functions/nutrition/_ingredientTerms.ts';

const GENERIC_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];
const TIER_RANK: Record<string, number> = {
  'Foundation': 0,
  'SR Legacy': 1,
  'Survey (FNDDS)': 2,
};

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
    } catch { /* next */ }
  }
  throw new Error('No env file found');
}

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

interface Candidate {
  source: string;
  source_id: string;
  data_type: string;
  description: string;
  calories_kcal: number | null;
}

function tokensOf(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/** Replicate the v2 ORDER BY in JS to pick the single best generic.
 *  Keep in step with the ranking in migration 20260608000400. */
function rankBest(terms: string[], cands: Candidate[]): Candidate | null {
  const termSet = new Set(terms);
  const head = terms[terms.length - 1] ?? '';
  let best: Candidate | null = null;
  let bestKey: number[] = [];
  for (const c of cands) {
    const descToks = tokensOf(c.description);
    const coverage = descToks.filter((t) => termSet.has(t)).length;
    const fullCoverage = terms.every((t) => descToks.includes(t));
    const headMatch = head !== '' && c.description.toLowerCase().startsWith(head);
    const specificity = descToks.length - terms.length; // smaller is better
    const key = [
      fullCoverage ? 0 : 1,
      headMatch ? 0 : 1,
      c.calories_kcal == null ? 1 : 0,
      -coverage,
      specificity,
      TIER_RANK[c.data_type] ?? 99,
      descToks.length,
    ];
    if (best === null || lt(key, bestKey)) {
      best = c;
      bestKey = key;
    }
  }
  return best;
}

function lt(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
}

async function fetchTopKeys(sb: SupabaseClient): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await sb.from('ingredients').select('name').range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as { name: string }[]) {
      const k = (r.name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    from += page;
    if (data.length < page) break;
  }
  return counts;
}

async function fetchCands(sb: SupabaseClient, like: string): Promise<Candidate[]> {
  const { data, error } = await sb
    .from('nutrition_foods_master')
    .select('source, source_id, data_type, description, calories_kcal')
    .in('data_type', GENERIC_TYPES)
    .ilike('description', `%${like}%`)
    .limit(200);
  if (error) throw error;
  return (data ?? []) as Candidate[];
}

async function proposeFor(
  sb: SupabaseClient,
  terms: string[],
): Promise<Candidate | null> {
  if (terms.length === 0) return null;
  // Fetch candidates by the distinctive head noun (the last term) so a
  // common modifier like "fresh" doesn't flood the candidate window and
  // bury the real food. Fall back to OR-of-all-terms if the head yields
  // nothing. (The live RPC scans the whole index, so it doesn't need
  // this; this is only to keep the offline proposal set reviewable.)
  const head = terms[terms.length - 1]!;
  let cands = await fetchCands(sb, head);
  if (cands.length === 0) {
    for (const t of terms) {
      cands = cands.concat(await fetchCands(sb, t));
      if (cands.length >= 50) break;
    }
  }
  return rankBest(terms, cands);
}

async function emitProposals(sb: SupabaseClient, topN: number) {
  const counts = await fetchTopKeys(sb);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  console.error(`proposing for top ${sorted.length} keys…`);
  for (const [key, count] of sorted) {
    const { terms } = extractIngredientTerms(key);
    let best: Candidate | null = null;
    try {
      best = await proposeFor(sb, terms);
    } catch (e) {
      console.error(`  ${key}: ${(e as Error).message}`);
    }
    if (best) {
      console.log(
        [key, count, best.source, best.source_id, best.data_type, best.description].join('\t'),
      );
    } else {
      console.log([key, count, '', '', '', '(no proposal)'].join('\t'));
    }
  }
}

async function emitSql(file: string) {
  const text = await Deno.readTextFile(file);
  const mappings: { key: string; source: string; source_id: string }[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [key, , source, source_id] = line.split('\t');
    if (!key || !source || !source_id) continue;
    mappings.push({ key: key.trim(), source: source.trim(), source_id: source_id.trim() });
  }
  // 1) Copy the referenced facts from master into the public cache so
  //    readCachedFact has data without a live search.
  const pairs = mappings.map((m) => `(${sqlStr(m.source)}, ${sqlStr(m.source_id)})`).join(',\n    ');
  console.log(`-- Generated by scripts/seed-nutrition-mappings.ts --emit-sql`);
  console.log(`insert into public.nutrition_facts_cache`);
  console.log(`  (source, source_id, description, brand, calories_kcal, protein_g, fat_g,`);
  console.log(`   saturated_fat_g, carbs_g, sugar_g, fiber_g, sodium_mg, portions, fetched_at)`);
  console.log(`select m.source, m.source_id, m.description, coalesce(m.brand, m.brand_owner),`);
  console.log(`       m.calories_kcal, m.protein_g, m.fat_g, m.saturated_fat_g, m.carbs_g,`);
  console.log(`       m.sugar_g, m.fiber_g, m.sodium_mg, m.portions, now()`);
  console.log(`from public.nutrition_foods_master m`);
  console.log(`where (m.source, m.source_id) in (\n    ${pairs}\n  )`);
  console.log(`on conflict (source, source_id) do nothing;\n`);
  // 2) Platform-default mappings (owner_id null).
  console.log(`insert into public.ingredient_nutrition_mappings`);
  console.log(`  (owner_id, ingredient_key, source, source_id, custom_grams_per_unit)`);
  console.log(`values`);
  const values = mappings.map(
    (m) => `  (null, ${sqlStr(m.key)}, ${sqlStr(m.source)}, ${sqlStr(m.source_id)}, '{}'::jsonb)`,
  );
  console.log(values.join(',\n'));
  console.log(`on conflict (owner_id, ingredient_key) do update set`);
  console.log(`  source = excluded.source, source_id = excluded.source_id;`);
}

async function main() {
  const emitSqlFile = arg('emit-sql');
  if (emitSqlFile) {
    await emitSql(emitSqlFile);
    return;
  }
  const env = await loadEnv(arg('env-file'));
  const URL_ = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY ?? env.SERVICE_ROLE_KEY ?? '';
  if (!URL_ || !KEY) throw new Error('Missing SUPABASE_URL or service-role key');
  const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  await emitProposals(sb, Number(arg('top') ?? '200'));
}

await main();
