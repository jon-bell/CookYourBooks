// Library-snapshot Edge Function.
//
// First-load accelerator for the local-first sync engine. The browser's
// full pull used to fetch the whole library as `select('*')` JSON over
// many paginated PostgREST round-trips — huge (every column name repeated
// on every row) and slow (dozens of requests). This function assembles
// the same data server-side, ships it as **columnar MessagePack** (column
// names once, then value-arrays; gzipped by the gateway), and lets the
// browser land it in two stages so the grid renders before the recipe
// bodies arrive:
//
//   POST { stage: 'meta',   scope, householdId? }
//     → { collections, recipes }  — recipe CARDS (folded JSON stripped)
//   POST { stage: 'bodies', scope, householdId? }
//     → { recipeBodies }  — id + ingredients/instructions JSON per recipe
//
// `scope: 'own'` returns the caller's library (owner_id = me).
// `scope: 'household'` returns co-members' shared content (household_id =
// my claim AND owner_id <> me) — same filter as pullHouseholdSharedContent.
//
// SECURITY: unlike import-worker (service role, woken by pg_net), this is
// called from the browser and reads under the CALLER'S RLS. We validate
// the user JWT, then run every query through a client scoped to that JWT,
// so the own / household claim-vs-column policies enforce visibility — the
// function never sees rows the user couldn't read via PostgREST directly.
// This is the third deliberate Edge Function (after import-worker +
// nutrition); it owns no secrets.

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { encode } from '@msgpack/msgpack';
import * as Sentry from 'https://esm.sh/@sentry/deno@9.46.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SENTRY_DSN = Deno.env.get('SENTRY_DSN');
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    release: Deno.env.get('SENTRY_RELEASE') ?? undefined,
    environment: Deno.env.get('SENTRY_ENVIRONMENT') ?? 'production',
    defaultIntegrations: false,
    tracesSampleRate: 1.0,
    initialScope: { tags: { component: 'library-snapshot' } },
  });
}

// PostgREST caps each response at the project max-rows (1000), so even
// server-side we page. The server↔db hop is co-located and cheap; the win
// is that the BROWSER makes two requests total instead of dozens.
const PAGE_SIZE = 1000;

type Row = Record<string, unknown>;

interface ColumnarTable {
  cols: string[];
  rows: unknown[][];
}

// Byte-identical to apps/web/src/local/snapshotCodec.ts `encodeColumnar`
// (same copy-verbatim convention as the OCR parser). Column order is taken
// from the first row; PostgREST returns every column for every row, so the
// keys are uniform.
function encodeColumnar(rows: readonly Row[]): ColumnarTable {
  if (rows.length === 0) return { cols: [], rows: [] };
  const cols = Object.keys(rows[0]!);
  const out: unknown[][] = new Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    const arr = new Array<unknown>(cols.length);
    for (let c = 0; c < cols.length; c += 1) arr[c] = r[cols[c]!];
    out[i] = arr;
  }
  return { cols, rows: out };
}

const SCHEMA_VERSION = 1;

type Scope = 'own' | 'household';

/** Apply the scope filter to a query builder, mirroring the sync engine. */
function scopeFilter(q: any, scope: Scope, userId: string, householdId: string | null): any {
  if (scope === 'household') {
    // RLS already narrows to (own OR household-claim); excluding our own
    // rows leaves exactly the co-members' shared content. Filtering on the
    // indexed household_id keeps it precise + fast.
    let out = q.neq('owner_id', userId);
    if (householdId) out = out.eq('household_id', householdId);
    return out;
  }
  return q.eq('owner_id', userId);
}

/** Page a table fully (ordered by id for a stable PK range scan). */
async function fetchAll(
  client: SupabaseClient,
  table: string,
  scope: Scope,
  userId: string,
  householdId: string | null,
  columns = '*',
): Promise<Row[]> {
  const out: Row[] = [];
  let afterId: string | null = null;
  const idCol = 'id';
  while (true) {
    let q = scopeFilter(
      client.from(table).select(columns),
      scope,
      userId,
      householdId,
    ).order(idCol, { ascending: true }).limit(PAGE_SIZE);
    if (afterId) q = q.gt(idCol, afterId);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    afterId = String(rows[rows.length - 1]![idCol]);
  }
  return out;
}

// ---------- HTTP ----------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/** Validate the bearer JWT; return { userId, token } or null. */
async function requireAuth(req: Request): Promise<{ userId: string; token: string } | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || token === SERVICE_ROLE_KEY) return null; // service role has no RLS scope here
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, token };
}

Deno.serve((req) =>
  Sentry.withScope(async () => {
    try {
      return await handle(req);
    } catch (err) {
      if (SENTRY_DSN) Sentry.captureException(err);
      console.error('unhandled invocation error', err);
      return json({ error: 'internal' }, 500);
    } finally {
      if (SENTRY_DSN) await Sentry.flush(2000);
    }
  }),
);

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const auth = await requireAuth(req);
  if (!auth) return json({ error: 'unauthorized' }, 401);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const stage = body.stage === 'bodies' ? 'bodies' : 'meta';
  const scope: Scope = body.scope === 'household' ? 'household' : 'own';
  const householdId = typeof body.householdId === 'string' ? body.householdId : null;

  // Run all reads under the caller's JWT so RLS (own / household claim)
  // enforces visibility.
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${auth.token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let envelope: Record<string, unknown>;
  if (stage === 'meta') {
    const [collections, recipes] = await Promise.all([
      fetchAll(client, 'recipe_collections', scope, auth.userId, householdId),
      fetchAll(client, 'recipes', scope, auth.userId, householdId),
    ]);
    // Strip the folded JSON so the meta stage stays a light recipe card and
    // the grid renders before bodies stream in.
    const cards = recipes.map((r) => {
      const { ingredients: _i, instructions: _n, ...card } = r as Row;
      return card;
    });
    envelope = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      collections: encodeColumnar(collections),
      recipes: encodeColumnar(cards),
    };
  } else {
    const recipeBodies = await fetchAll(
      client,
      'recipes',
      scope,
      auth.userId,
      householdId,
      'id,ingredients,instructions',
    );
    envelope = {
      schemaVersion: SCHEMA_VERSION,
      recipeBodies: encodeColumnar(recipeBodies),
    };
  }

  // Use application/octet-stream (not application/msgpack): supabase-js's
  // functions.invoke only treats octet-stream as binary (→ Blob). Any other
  // unrecognized content-type falls through to response.text(), which
  // UTF-8-decodes the MessagePack bytes into a lossy string — the client then
  // can't decode it and falls back to the keyset path. The body is the same
  // MessagePack either way; only the label decides how the client parses it.
  return new Response(encode(envelope), {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', ...CORS_HEADERS },
  });
}
