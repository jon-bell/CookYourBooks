// HTTP entrypoint + worker loop. Drains the bulk-OCR queue.
//
// Invocation:
//   POST /functions/v1/import-worker
//   Body: { "batch_id": "uuid" | null }
//
// Behaviour:
//   - Loop budget is the smaller of 60s wall-clock OR queue empty OR
//     two consecutive empty-claim ticks.
//   - Claims up to 8 items at a time, processes 3 in parallel.
//   - Returns { processed, failed, parked, remaining }. If remaining
//     > 0, fires a fire-and-forget self-invoke so the user doesn't
//     have to wait for the next 30s cron tick.

// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.1';
import pricingCard from './pricing.json' with { type: 'json' };
import { runOcr, type ErrorKind, type Provider } from './ocr.ts';
import { parseLlmJson, parseTocJson, type ParsedRecipeDraft, type TocEntry } from './parser.ts';
import { RECIPE_PROMPT, TOC_PROMPT } from './prompts.ts';

interface ImportItem {
  id: string;
  batch_id: string;
  owner_id: string;
  page_index: number;
  storage_path: string;
  /** Additional scanned pages folded into this item via the merge
   *  action. Sent to the LLM together with the primary in one call. */
  extra_storage_paths: string[] | null;
  is_toc: boolean;
  status: string;
  claim_token: string | null;
  attempts: number;
  needs_fallback: boolean;
}

interface ImportBatch {
  id: string;
  owner_id: string;
  default_model: string;
  default_provider: Provider;
  default_prompt: string | null;
  fallback_model: string | null;
  fallback_provider: Provider | null;
  recitation_policy: 'ASK' | 'FALLBACK' | 'FAIL';
}

interface BakeoffVariant {
  id: string;
  run_id: string;
  owner_id: string;
  name: string;
  provider: Provider;
  model: string;
  prompt: string;
  base_url: string | null;
  attempts: number;
}

interface UserKey {
  apiKey: string;
  baseUrl: string | null;
}

interface PricingEntry {
  provider: string;
  model: string;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}
interface PricingCard {
  entries: PricingEntry[];
  fallback: { input_usd_per_mtok: number; output_usd_per_mtok: number };
}
const PRICING = pricingCard as PricingCard;

// Per-invocation wall clock. Has to be larger than the longest per-
// item OCR call (see ocrTimeoutForImages in ocr.ts) so an in-flight
// merged-pages call gets a chance to finish before the loop exits.
// Sub the platform ceiling (150s free / 400s pro on hosted Supabase)
// so we never hit a hard kill from the runtime.
const LOOP_BUDGET_MS = parseIntEnvOr('OCR_LOOP_BUDGET_MS', 300_000);
const CLAIM_BATCH = parseIntEnvOr('OCR_CLAIM_BATCH', 8);
const PARALLEL = parseIntEnvOr('OCR_PARALLEL', 3);
const LEASE_SECONDS = parseIntEnvOr('OCR_LEASE_SECONDS', 600);
const MAX_TRANSIENT_RETRIES = 3;
const MAX_PARSE_RETRIES = 2;
const MAX_NETWORK_FETCH_RETRIES = 2;

function parseIntEnvOr(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SUPABASE_URL = mustEnv('SUPABASE_URL');
const SERVICE_ROLE = mustEnv('SUPABASE_SERVICE_ROLE_KEY');
const MOCK_MODE = Deno.env.get('OCR_MOCK_MODE') === '1';

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// ---------- structured logger ----------
//
// Every log line carries the worker id and (when available) the item +
// batch id, so the Supabase log viewer can be filtered to one slice of
// activity. The shape is intentionally flat (no nested objects) so the
// JSON column in the log store is grep-able.

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogContext {
  worker?: string;
  batch?: string;
  item?: string;
  step?: string;
}

function logLine(level: LogLevel, message: string, ctx: LogContext, extra?: Record<string, unknown>): void {
  const payload = {
    t: new Date().toISOString(),
    lvl: level,
    msg: message,
    ...ctx,
    ...(extra ?? {}),
  };
  const line = `[import-worker] ${JSON.stringify(payload)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function makeLog(ctx: LogContext) {
  return {
    info: (m: string, extra?: Record<string, unknown>) => logLine('info', m, ctx, extra),
    warn: (m: string, extra?: Record<string, unknown>) => logLine('warn', m, ctx, extra),
    error: (m: string, extra?: Record<string, unknown>) => logLine('error', m, ctx, extra),
    debug: (m: string, extra?: Record<string, unknown>) => logLine('debug', m, ctx, extra),
    child: (next: LogContext) => makeLog({ ...ctx, ...next }),
  };
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// Boot banner so a fresh function instance is obvious in the log.
logLine('info', 'boot', {}, {
  mock_mode: MOCK_MODE,
  supabase_url: SUPABASE_URL,
  service_role_present: SERVICE_ROLE.length > 0,
  loop_budget_ms: LOOP_BUDGET_MS,
  claim_batch: CLAIM_BATCH,
  parallel: PARALLEL,
  lease_seconds: LEASE_SECONDS,
});

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- HTTP entry ----------

// The function runs with `verify_jwt = false` so pg_net (which signs
// with the project's service-role JWT and is rejected by the gateway
// when the project enforces legacy-secret JWTs) can reach us. We do
// our own bearer check here: every caller must present the same
// service-role key the function itself holds. Anonymous traffic, anon
// keys, and stale tokens all get a 401 from us.
function authorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${SERVICE_ROLE}`;
  if (header.length !== expected.length) return false;
  // Constant-time compare to keep this honest.
  let diff = 0;
  for (let i = 0; i < header.length; i += 1) {
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }
  if (!authorized(req)) {
    logLine('warn', 'unauthorized request', {}, {
      auth_header_present: req.headers.has('authorization'),
    });
    return json({ error: 'unauthorized' }, 401);
  }
  let body: { batch_id?: string | null } = {};
  try {
    const text = await req.text();
    if (text.length > 0) body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const batchId = body.batch_id ?? null;

  const workerId = `edge:${crypto.randomUUID()}`;
  const wLog = makeLog({ worker: shortId(workerId), batch: batchId ? shortId(batchId) : undefined });
  wLog.info('invocation start');
  const summary = await runLoop(workerId, batchId, wLog);
  // Drain any pending bakeoff variants in the same invocation. Variants
  // are per-user, so we don't filter by batch — the page that just
  // started the bakeoff kicks us, and we pull anything queued.
  const bakeoffSummary = await runBakeoffLoop(workerId, wLog);
  wLog.info('invocation end', {
    ...summary,
    bakeoff_processed: bakeoffSummary.processed,
    bakeoff_failed: bakeoffSummary.failed,
  });

  if (summary.remaining > 0) {
    wLog.info('self-invoke (queue not drained)', { remaining: summary.remaining });
    fireSelfInvoke(batchId);
  }

  return json(summary, 200);
});

// ---------- main loop ----------

interface LoopSummary {
  processed: number;
  failed: number;
  parked: number;
  remaining: number;
}

async function runLoop(
  workerId: string,
  batchId: string | null,
  log: ReturnType<typeof makeLog>,
): Promise<LoopSummary> {
  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  let parked = 0;
  let emptyTicks = 0;

  while (Date.now() - startedAt < LOOP_BUDGET_MS) {
    const items = await claimBatch(workerId, batchId, log);
    if (items.length === 0) {
      emptyTicks++;
      log.info('empty claim', { empty_ticks: emptyTicks });
      if (emptyTicks >= 2) break;
      continue;
    }
    emptyTicks = 0;
    log.info('claimed items', { count: items.length, ids: items.map((i) => shortId(i.id)) });

    for (let i = 0; i < items.length; i += PARALLEL) {
      const chunk = items.slice(i, i + PARALLEL);
      const results = await Promise.all(
        chunk.map((it) =>
          processItem(it, workerId, log.child({ item: shortId(it.id), batch: shortId(it.batch_id) })),
        ),
      );
      for (const r of results) {
        if (r === 'OCR_DONE') processed++;
        else if (r === 'NEEDS_FALLBACK') parked++;
        else failed++;
      }
      if (Date.now() - startedAt >= LOOP_BUDGET_MS) {
        log.info('loop budget hit, draining current chunk only');
        break;
      }
    }
  }

  const remaining = await countPending(batchId, log);
  return { processed, failed, parked, remaining };
}

async function claimBatch(
  workerId: string,
  batchId: string | null,
  log: ReturnType<typeof makeLog>,
): Promise<ImportItem[]> {
  const { data, error } = await supabase.rpc('import_claim_next', {
    p_worker_id: workerId,
    p_batch_id: batchId,
    p_lease_seconds: LEASE_SECONDS,
    p_limit: CLAIM_BATCH,
  });
  if (error) {
    log.error('import_claim_next failed', { code: error.code, message: error.message });
    return [];
  }
  return (data ?? []) as ImportItem[];
}

async function countPending(batchId: string | null, log: ReturnType<typeof makeLog>): Promise<number> {
  let q = supabase
    .from('import_items')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'PENDING');
  if (batchId) q = q.eq('batch_id', batchId);
  const { count, error } = await q;
  if (error) {
    log.error('countPending failed', { code: error.code, message: error.message });
    return 0;
  }
  return count ?? 0;
}

// ---------- per-item pipeline ----------

type ItemOutcome = 'OCR_DONE' | 'PENDING' | 'NEEDS_FALLBACK' | 'OCR_FAILED';

async function processItem(
  item: ImportItem,
  workerId: string,
  log: ReturnType<typeof makeLog>,
): Promise<ItemOutcome> {
  const claimToken = workerId;
  log.info('process start', {
    is_toc: item.is_toc,
    attempts: item.attempts,
    status: item.status,
    needs_fallback: item.needs_fallback,
    storage_path: item.storage_path,
  });

  const batch = await loadBatch(item.batch_id, log);
  if (!batch) {
    log.error('batch missing — terminal');
    await failItem(
      item,
      claimToken,
      mkAttempt('', '', 'OTHER', 'Batch missing.', '', 0, 0, 0),
      'OCR_FAILED',
      log,
    );
    return 'OCR_FAILED';
  }
  log.info('batch loaded', {
    default_provider: batch.default_provider,
    default_model: batch.default_model,
    fallback_provider: batch.fallback_provider,
    fallback_model: batch.fallback_model,
    recitation_policy: batch.recitation_policy,
  });

  // `needs_fallback` is the server's hint that a previous attempt
  // tripped the recitation guardrail and the user (or the batch policy)
  // opted into the fallback model. The legacy item.status === 'NEEDS_FALLBACK'
  // check is preserved as a defensive synonym — in practice the
  // import_set_recitation_policy RPC moves the row back to PENDING
  // before the worker reclaims it.
  const useFallback = item.needs_fallback === true || item.status === 'NEEDS_FALLBACK';
  if (useFallback) {
    log.info('using fallback model');
    if (!batch.fallback_provider || !batch.fallback_model) {
      log.error('fallback requested but not configured');
      await failItem(
        item,
        claimToken,
        mkAttempt(
          batch.fallback_provider ?? batch.default_provider,
          batch.fallback_model ?? batch.default_model,
          'AUTH',
          'Fallback model not configured (set one in Settings)',
          '',
          0,
          0,
          0,
        ),
        'OCR_FAILED',
        log,
      );
      return 'OCR_FAILED';
    }
  }
  const provider = useFallback ? batch.fallback_provider! : batch.default_provider;
  const model = useFallback ? batch.fallback_model! : batch.default_model;
  if (!model) {
    log.error('no model configured on batch');
    await failItem(item, claimToken, mkAttempt(provider, model, 'OTHER', 'No model configured on batch.', '', 0, 0, 0), 'OCR_FAILED', log);
    return 'OCR_FAILED';
  }
  log.info('resolved provider/model', { provider, model });

  // Key lookup.
  let key: UserKey | null = null;
  try {
    key = await loadUserKey(item.owner_id, provider, log);
  } catch (err) {
    log.error('loadUserKey threw', { error: err instanceof Error ? err.message : String(err) });
  }
  if (!key && !MOCK_MODE) {
    const message = useFallback
      ? 'Fallback model not configured (set one in Settings)'
      : `No API key configured for ${provider}. Add it in Settings.`;
    log.error('no key configured', { provider });
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'AUTH', message, '', 0, 0, 0),
      'OCR_FAILED',
      log,
    );
    return 'OCR_FAILED';
  }
  if (key) log.info('key resolved', { has_base_url: !!key.baseUrl });

  // Image fetch (with up to 2 retries on transient). The merge action
  // can fold extra pages onto an item; we pull them all here and send
  // them to the LLM together so a recipe that spans a page break gets
  // OCR'd as one.
  const allPaths = [item.storage_path, ...(item.extra_storage_paths ?? [])];
  const images: { bytes: Uint8Array; mime: string }[] = [];
  let fetchError: string | undefined;
  const fetchStart = Date.now();
  for (const path of allPaths) {
    let attempt = 0;
    let got: { bytes: Uint8Array; mime: string } | undefined;
    while (attempt <= MAX_NETWORK_FETCH_RETRIES) {
      try {
        got = await fetchImage(item.owner_id, path);
        break;
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
        log.warn('image fetch error', { attempt, path, error: fetchError });
        attempt++;
      }
    }
    if (!got) break;
    images.push(got);
  }
  if (images.length !== allPaths.length) {
    const nextState: 'PENDING' | 'OCR_FAILED' =
      item.attempts < MAX_NETWORK_FETCH_RETRIES ? 'PENDING' : 'OCR_FAILED';
    log.error('image fetch exhausted retries', {
      got: images.length,
      expected: allPaths.length,
      next_state: nextState,
      error: fetchError,
    });
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'NETWORK', `Image fetch failed: ${fetchError ?? 'unknown'}`, '', 0, 0, 0),
      nextState,
      log,
    );
    return nextState as ItemOutcome;
  }
  const imageBytes = images[0]!.bytes;
  const imageMime = images[0]!.mime;
  log.info('images fetched', {
    count: images.length,
    total_bytes: images.reduce((acc, i) => acc + i.bytes.length, 0),
    latency_ms: Date.now() - fetchStart,
  });

  // OCR call (with possible in-invocation FALLBACK on recitation).
  log.info('llm call start', {
    provider,
    model,
    is_toc: item.is_toc,
    images: images.length,
  });
  const result = await runOrMock({
    item,
    provider,
    model,
    apiKey: key?.apiKey ?? '',
    baseUrl: key?.baseUrl ?? undefined,
    prompt: item.is_toc ? TOC_PROMPT : (batch.default_prompt || RECIPE_PROMPT),
    images: images.map((i) => ({ base64: bytesToBase64(i.bytes), mimeType: i.mime })),
    log,
  });
  log.info('llm call end', {
    error_kind: result.errorKind,
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    latency_ms: result.latencyMs,
    response_chars: result.rawResponse?.length ?? 0,
    error_message: result.errorMessage,
  });

  // Recitation routing.
  if (result.errorKind === 'RECITATION') {
    log.warn('recitation', { policy: batch.recitation_policy });
    return await handleRecitation(item, batch, claimToken, provider, model, images, result, log);
  }

  // Transient errors.
  if (result.errorKind === 'RATE_LIMIT' || result.errorKind === 'NETWORK' || result.errorKind === 'TIMEOUT') {
    const rawPath = await uploadRaw(item, result.rawResponse, log);
    const nextState = item.attempts < MAX_TRANSIENT_RETRIES ? 'PENDING' : 'OCR_FAILED';
    log.warn('transient llm error', { kind: result.errorKind, message: result.errorMessage, next_state: nextState });
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, result.errorKind, result.errorMessage ?? result.errorKind, rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      nextState,
      log,
    );
    return nextState as ItemOutcome;
  }

  if (result.errorKind === 'AUTH' || result.errorKind === 'OTHER') {
    const rawPath = await uploadRaw(item, result.rawResponse, log);
    log.error('terminal llm error', { kind: result.errorKind, message: result.errorMessage });
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, result.errorKind, result.errorMessage ?? result.errorKind, rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      'OCR_FAILED',
      log,
    );
    return 'OCR_FAILED';
  }

  // Parse + persist.
  return await parseAndComplete(item, batch, claimToken, provider, model, result, log);
}

async function handleRecitation(
  item: ImportItem,
  batch: ImportBatch,
  claimToken: string,
  provider: Provider,
  model: string,
  images: ReadonlyArray<{ bytes: Uint8Array; mime: string }>,
  result: Awaited<ReturnType<typeof runOrMock>>,
  log: ReturnType<typeof makeLog>,
): Promise<ItemOutcome> {
  const rawPath = await uploadRaw(item, result.rawResponse, log);

  if (batch.recitation_policy === 'ASK') {
    log.info('parking for user decision', { policy: 'ASK' });
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'RECITATION', result.errorMessage ?? 'Model declined due to recitation guardrail.', rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      'NEEDS_FALLBACK',
      log,
    );
    return 'NEEDS_FALLBACK';
  }

  if (batch.recitation_policy === 'FAIL') {
    log.warn('recitation policy=FAIL — terminal');
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'RECITATION', result.errorMessage ?? 'Recitation; policy=FAIL.', rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      'OCR_FAILED',
      log,
    );
    return 'OCR_FAILED';
  }

  // FALLBACK: retry inline with the fallback config, if one is set.
  const fbProvider = batch.fallback_provider;
  const fbModel = batch.fallback_model;
  if (!fbProvider || !fbModel) {
    log.error('FALLBACK policy but no fallback configured');
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'RECITATION', 'Recitation; no fallback configured.', rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      'OCR_FAILED',
      log,
    );
    return 'OCR_FAILED';
  }
  log.info('retrying inline with fallback', { fb_provider: fbProvider, fb_model: fbModel });
  const fbKey = await loadUserKey(item.owner_id, fbProvider, log);
  if (!fbKey && !MOCK_MODE) {
    log.error('no key for fallback provider', { fb_provider: fbProvider });
    await failItem(
      item,
      claimToken,
      mkAttempt(fbProvider, fbModel, 'AUTH', `No API key configured for fallback provider ${fbProvider}.`, rawPath, 0, 0, 0),
      'OCR_FAILED',
      log,
    );
    return 'OCR_FAILED';
  }

  const fbResult = await runOrMock({
    item,
    provider: fbProvider,
    model: fbModel,
    apiKey: fbKey?.apiKey ?? '',
    baseUrl: fbKey?.baseUrl ?? undefined,
    prompt: item.is_toc ? TOC_PROMPT : (batch.default_prompt || RECIPE_PROMPT),
    images: images.map((i) => ({ base64: bytesToBase64(i.bytes), mimeType: i.mime })),
    log,
  });
  log.info('fallback llm call end', {
    error_kind: fbResult.errorKind,
    prompt_tokens: fbResult.promptTokens,
    completion_tokens: fbResult.completionTokens,
    latency_ms: fbResult.latencyMs,
  });
  const fbRawPath = await uploadRaw(item, fbResult.rawResponse, log);

  if (fbResult.errorKind === 'OK') {
    return await parseAndComplete(item, batch, claimToken, fbProvider, fbModel, { ...fbResult, rawResponsePath: fbRawPath }, log);
  }
  if (fbResult.errorKind === 'RECITATION') {
    log.warn('fallback also recitated — terminal');
    await failItem(
      item,
      claimToken,
      mkAttempt(fbProvider, fbModel, 'RECITATION', 'Fallback also tripped recitation.', fbRawPath, fbResult.promptTokens, fbResult.completionTokens, fbResult.latencyMs),
      'OCR_FAILED',
      log,
    );
    return 'OCR_FAILED';
  }
  // Other errors on fallback: terminal.
  log.error('fallback llm errored — terminal', { kind: fbResult.errorKind, message: fbResult.errorMessage });
  await failItem(
    item,
    claimToken,
    mkAttempt(fbProvider, fbModel, fbResult.errorKind, fbResult.errorMessage ?? fbResult.errorKind, fbRawPath, fbResult.promptTokens, fbResult.completionTokens, fbResult.latencyMs),
    'OCR_FAILED',
    log,
  );
  return 'OCR_FAILED';
}

async function parseAndComplete(
  item: ImportItem,
  batch: ImportBatch,
  claimToken: string,
  provider: Provider,
  model: string,
  result: Awaited<ReturnType<typeof runOrMock>> & { rawResponsePath?: string },
  log: ReturnType<typeof makeLog>,
): Promise<ItemOutcome> {
  const rawPath = result.rawResponsePath ?? (await uploadRaw(item, result.rawResponse, log));
  const text = result.text ?? '';

  let drafts: ParsedRecipeDraft[] = [];
  let tocEntries: TocEntry[] = [];
  try {
    if (item.is_toc) {
      tocEntries = parseTocJson(text);
    } else {
      drafts = parseLlmJson(text);
    }
    log.info('parse ok', { drafts: drafts.length, toc_entries: tocEntries.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const nextState: 'PENDING' | 'OCR_FAILED' =
      item.attempts < MAX_PARSE_RETRIES ? 'PENDING' : 'OCR_FAILED';
    log.warn('parse error', { message: msg, next_state: nextState, text_preview: text.slice(0, 200) });
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'PARSE', msg, rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      nextState,
      log,
    );
    return nextState as ItemOutcome;
  }

  const cost = costUsdMicros(provider, model, result.promptTokens, result.completionTokens);
  const attemptPayload = {
    provider,
    model,
    raw_response_path: rawPath,
    error_kind: 'OK',
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    cost_usd_micros: cost,
    latency_ms: result.latencyMs,
  };

  if (item.is_toc) {
    const rows = tocEntries.map((e) => ({
      batch_id: item.batch_id,
      item_id: item.id,
      owner_id: item.owner_id,
      title: e.title,
      page_number: e.page_number,
    }));
    if (rows.length > 0) {
      const { error } = await supabase.from('import_toc_entries').insert(rows);
      if (error) log.error('toc_entries insert', { code: error.code, message: error.message });
    }
  }

  const { data: ok, error } = await supabase.rpc('import_complete', {
    p_item_id: item.id,
    p_claim_token: claimToken,
    p_attempt: attemptPayload,
    p_parsed_drafts: drafts,
  });
  if (error) {
    log.error('import_complete error', { code: error.code, message: error.message });
    return 'OCR_FAILED';
  }
  if (!ok) {
    log.warn('import_complete returned false (lease lost)');
  } else {
    log.info('import_complete ok', { cost_usd_micros: cost });
  }
  return 'OCR_DONE';
}

// ---------- bakeoff variant pipeline ----------
//
// Each variant in a run is processed independently of the others, so a
// slow model never blocks a cheap one. We reuse the same fetch / LLM
// call / parse path as the bulk-import flow, but write results into
// `bakeoff_variants` rather than `import_items`.

async function runBakeoffLoop(
  workerId: string,
  log: ReturnType<typeof makeLog>,
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  // One claim pass per invocation; the page polls bakeoff_variants and
  // can kick the worker again if a variant lingers. Keeping this simple
  // avoids fighting with the import loop for parallelism budget.
  const variants = await claimBakeoffBatch(workerId, log);
  if (variants.length === 0) return { processed, failed };
  log.info('claimed variants', { count: variants.length });

  for (let i = 0; i < variants.length; i += PARALLEL) {
    const chunk = variants.slice(i, i + PARALLEL);
    const results = await Promise.all(
      chunk.map((v) =>
        processVariant(v, workerId, log.child({ item: shortId(v.id) })),
      ),
    );
    for (const r of results) {
      if (r === 'DONE') processed++;
      else failed++;
    }
  }
  return { processed, failed };
}

async function claimBakeoffBatch(
  workerId: string,
  log: ReturnType<typeof makeLog>,
): Promise<BakeoffVariant[]> {
  const { data, error } = await supabase.rpc('bakeoff_claim_next', {
    p_worker_id: workerId,
    p_lease_seconds: LEASE_SECONDS,
    p_limit: CLAIM_BATCH,
  });
  if (error) {
    log.error('bakeoff_claim_next failed', { code: error.code, message: error.message });
    return [];
  }
  return (data ?? []) as BakeoffVariant[];
}

async function processVariant(
  variant: BakeoffVariant,
  workerId: string,
  log: ReturnType<typeof makeLog>,
): Promise<'DONE' | 'FAILED'> {
  log.info('variant start', {
    provider: variant.provider,
    model: variant.model,
    name: variant.name,
  });
  const claimToken = workerId;
  const started = Date.now();

  // Look up the parent run so we know which image to load.
  const { data: run, error: runErr } = await supabase
    .from('bakeoff_runs')
    .select('id, owner_id, image_storage_path')
    .eq('id', variant.run_id)
    .maybeSingle();
  if (runErr || !run) {
    log.error('bakeoff_run missing', { run_id: variant.run_id, error: runErr?.message });
    await failVariant(
      variant,
      claimToken,
      'OTHER',
      'Parent bakeoff_run not found.',
      Date.now() - started,
      log,
    );
    return 'FAILED';
  }

  // Resolve the API key. Bakeoff variants share the user's vault keys
  // with the bulk-import flow — no separate creds.
  let key: UserKey | null = null;
  try {
    key = await loadUserKey(variant.owner_id, variant.provider, log);
  } catch (err) {
    log.error('loadUserKey threw', { error: err instanceof Error ? err.message : String(err) });
  }
  if (!key && !MOCK_MODE) {
    await failVariant(
      variant,
      claimToken,
      'AUTH',
      `No API key configured for ${variant.provider}. Add it in Settings.`,
      Date.now() - started,
      log,
    );
    return 'FAILED';
  }

  let image: { bytes: Uint8Array; mime: string };
  try {
    image = await fetchImage(variant.owner_id, run.image_storage_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('image fetch failed', { error: msg });
    await failVariant(variant, claimToken, 'NETWORK', msg, Date.now() - started, log);
    return 'FAILED';
  }

  const result = await runOrMock({
    item: { id: variant.id, storage_path: run.image_storage_path },
    provider: variant.provider,
    model: variant.model,
    apiKey: key?.apiKey ?? '',
    baseUrl: key?.baseUrl ?? variant.base_url ?? undefined,
    prompt: variant.prompt,
    images: [{ base64: bytesToBase64(image.bytes), mimeType: image.mime }],
    bakeoff: true,
    log,
  });
  log.info('variant llm end', {
    error_kind: result.errorKind,
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    latency_ms: result.latencyMs,
  });

  if (result.errorKind !== 'OK') {
    await failVariant(
      variant,
      claimToken,
      result.errorKind,
      result.errorMessage ?? result.errorKind,
      result.latencyMs || Date.now() - started,
      log,
    );
    return 'FAILED';
  }

  const text = result.text ?? result.rawResponse;
  let drafts: ParsedRecipeDraft[];
  try {
    drafts = parseLlmJson(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('variant parse error', { message: msg });
    await failVariant(
      variant,
      claimToken,
      'PARSE',
      msg,
      result.latencyMs || Date.now() - started,
      log,
    );
    return 'FAILED';
  }

  const cost = costUsdMicros(
    variant.provider,
    variant.model,
    result.promptTokens,
    result.completionTokens,
  );
  const payload = {
    drafts,
    raw_text: text,
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    cost_usd_micros: cost,
    latency_ms: result.latencyMs || Date.now() - started,
  };
  const { data: ok, error } = await supabase.rpc('bakeoff_complete', {
    p_variant_id: variant.id,
    p_claim_token: claimToken,
    p_result: payload,
  });
  if (error) {
    log.error('bakeoff_complete error', { code: error.code, message: error.message });
    return 'FAILED';
  }
  if (!ok) log.warn('bakeoff_complete returned false (lease lost)');
  return 'DONE';
}

async function failVariant(
  variant: BakeoffVariant,
  claimToken: string,
  errorKind: ErrorKind,
  errorMessage: string,
  latencyMs: number,
  log: ReturnType<typeof makeLog>,
): Promise<void> {
  const { error } = await supabase.rpc('bakeoff_fail', {
    p_variant_id: variant.id,
    p_claim_token: claimToken,
    p_error_kind: errorKind,
    p_error_message: errorMessage,
    p_latency_ms: latencyMs,
  });
  if (error) {
    log.error('bakeoff_fail rpc error', { code: error.code, message: error.message });
  }
}

// ---------- helpers ----------

interface AttemptShape {
  provider: string;
  model: string;
  raw_response_path: string | null;
  error_kind: ErrorKind;
  error_message: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd_micros: number;
  latency_ms: number;
}

function mkAttempt(
  provider: string,
  model: string,
  errorKind: ErrorKind,
  errorMessage: string,
  rawPath: string,
  promptTokens: number,
  completionTokens: number,
  latencyMs: number,
): AttemptShape {
  const cost = costUsdMicros(provider, model, promptTokens, completionTokens);
  return {
    provider,
    model,
    raw_response_path: rawPath || null,
    error_kind: errorKind,
    error_message: errorMessage,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cost_usd_micros: cost,
    latency_ms: latencyMs,
  };
}

async function failItem(
  item: ImportItem,
  claimToken: string,
  attempt: AttemptShape,
  nextState: 'PENDING' | 'NEEDS_FALLBACK' | 'OCR_FAILED',
  log: ReturnType<typeof makeLog>,
): Promise<void> {
  log.info('fail item', {
    next_state: nextState,
    error_kind: attempt.error_kind,
    error_message: attempt.error_message,
  });
  const { data: ok, error } = await supabase.rpc('import_fail', {
    p_item_id: item.id,
    p_claim_token: claimToken,
    p_attempt: attempt,
    p_next_state: nextState,
  });
  if (error) {
    log.error('import_fail rpc error', { code: error.code, message: error.message });
    return;
  }
  if (!ok) log.warn('import_fail returned false (lease lost)');
}

async function loadBatch(batchId: string, log: ReturnType<typeof makeLog>): Promise<ImportBatch | null> {
  const { data, error } = await supabase
    .from('import_batches')
    .select('id, owner_id, default_model, default_provider, default_prompt, fallback_model, fallback_provider, recitation_policy')
    .eq('id', batchId)
    .maybeSingle();
  if (error) {
    log.error('loadBatch failed', { code: error.code, message: error.message });
    return null;
  }
  return (data as ImportBatch | null) ?? null;
}

async function loadUserKey(
  ownerId: string,
  provider: Provider,
  log: ReturnType<typeof makeLog>,
): Promise<UserKey | null> {
  // The vault schema isn't exposed through PostgREST, so we tunnel the
  // decrypt through a security-definer RPC that lives in `public`.
  const { data, error } = await supabase.rpc('ocr_resolve_key', {
    p_owner_id: ownerId,
    p_provider: provider,
  });
  if (error) {
    log.error('ocr_resolve_key', { code: error.code, message: error.message });
    return null;
  }
  const row = (data as Array<{ api_key: string; base_url: string | null }> | null)?.[0];
  if (!row) {
    log.warn('no key row for owner+provider', { provider });
    return null;
  }
  return { apiKey: row.api_key, baseUrl: row.base_url };
}

async function fetchImage(
  ownerId: string,
  storagePath: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  if (MOCK_MODE) {
    // In mock mode we don't need the actual bytes — the fixture row
    // carries the model output. Stub with a 1x1 PNG.
    const stub = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return { bytes: stub, mime: 'image/png' };
  }
  const { data, error } = await supabase.storage
    .from('imports')
    .createSignedUrl(storagePath, 60);
  if (error || !data) {
    throw new Error(`signed URL: ${error?.message ?? 'unknown'}`);
  }
  const resp = await fetch(data.signedUrl);
  if (!resp.ok) {
    throw new Error(`storage GET ${resp.status} for ${storagePath}`);
  }
  const mime = resp.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
  const bytes = new Uint8Array(await resp.arrayBuffer());
  // Ownership is implicit: storage_path is `{owner_id}/...` by policy.
  if (ownerId && !storagePath.startsWith(`${ownerId}/`)) {
    throw new Error(`storage path ${storagePath} not owned by ${ownerId}`);
  }
  return { bytes, mime };
}

async function uploadRaw(
  item: ImportItem,
  body: string,
  log: ReturnType<typeof makeLog>,
): Promise<string> {
  const attemptUuid = crypto.randomUUID();
  const path = `${item.owner_id}/${item.batch_id}/raw/${attemptUuid}.txt`;
  const { error } = await supabase.storage
    .from('imports')
    .upload(path, new Blob([body], { type: 'text/plain' }), { upsert: false });
  if (error) {
    log.error('uploadRaw failed', { path, message: error.message });
    return '';
  }
  return path;
}

function costUsdMicros(provider: string, model: string, prompt: number, completion: number): number {
  const hit = PRICING.entries.find((p) => p.provider === provider && p.model === model);
  const rate = hit
    ? { in: hit.input_usd_per_mtok, out: hit.output_usd_per_mtok }
    : { in: PRICING.fallback.input_usd_per_mtok, out: PRICING.fallback.output_usd_per_mtok };
  const usd = (prompt * rate.in + completion * rate.out) / 1_000_000;
  return Math.round(usd * 1_000_000);
}

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid the spread-into-fromCharCode pattern: it blows the call
  // stack on large images. Chunk into 32 KB.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fireSelfInvoke(batchId: string | null): void {
  const url = `${SUPABASE_URL}/functions/v1/import-worker`;
  // Don't await — fire and forget. Errors here are harmless; the
  // cron tick or the next user kick will pick up the slack.
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ batch_id: batchId }),
  }).catch((err) => logLine('warn', 'self-invoke failed', {}, { error: err instanceof Error ? err.message : String(err) }));
}

// ---------- mock mode ----------

interface OcrCallLike {
  errorKind: ErrorKind;
  rawResponse: string;
  text?: string;
  promptTokens: number;
  completionTokens: number;
  errorMessage?: string;
  latencyMs: number;
}

async function runOrMock(p: {
  item: { id: string; storage_path: string };
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  prompt: string;
  images: ReadonlyArray<{ base64: string; mimeType: string }>;
  /** When true, the mock-mode fixture lookup uses the `bakeoff:*`
   *  wildcard sentinel instead of the plain `*`. Keeps bakeoff fixtures
   *  isolated from photo-import fixtures in the shared fixture table. */
  bakeoff?: boolean;
  log?: ReturnType<typeof makeLog>;
}): Promise<OcrCallLike> {
  if (!MOCK_MODE) {
    return await runOcr({
      provider: p.provider,
      model: p.model,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      prompt: p.prompt,
      images: p.images,
      log: p.log
        ? (m: string, extra?: Record<string, unknown>) => p.log!.info(m, extra)
        : undefined,
    });
  }

  // Lookup precedence: most-specific (path × provider × model) first,
  // then progressively wider. Bakeoff variants seed `(path='bakeoff:*',
  // provider, model)` rows so each variant returns a distinct payload
  // regardless of which random storage path the BakeoffPage uploaded to.
  // Bulk imports use `('*', provider, '')` — model-agnostic — so a single
  // fixture row covers every batch. The two wildcard sentinels are kept
  // distinct so a bakeoff fixture seeded by one test can't be picked up
  // by an unrelated photo-import test in the same DB.
  const bakeoffWildcard = p.bakeoff ? 'bakeoff:*' : '*';
  let row: { response_json: unknown; error_kind: ErrorKind | null; latency_ms: number | null } | null = null;
  const probes: Array<{ path: string; provider: string; model: string }> = p.bakeoff
    ? [
        { path: p.item.storage_path, provider: p.provider, model: p.model },
        { path: p.item.storage_path, provider: p.provider, model: '' },
        { path: bakeoffWildcard, provider: p.provider, model: p.model },
        { path: bakeoffWildcard, provider: p.provider, model: '' },
      ]
    : [
        { path: p.item.storage_path, provider: p.provider, model: p.model },
        { path: p.item.storage_path, provider: p.provider, model: '' },
        { path: '*', provider: p.provider, model: '' },
        { path: p.item.storage_path, provider: '', model: '' },
      ];
  for (const probe of probes) {
    const { data, error } = await supabase
      .from('ocr_test_fixtures')
      .select('response_json, error_kind, latency_ms')
      .eq('item_storage_path', probe.path)
      .eq('provider', probe.provider)
      .eq('model', probe.model)
      .maybeSingle();
    if (error) {
      logLine('error', 'ocr_test_fixtures lookup', { item: shortId(p.item.id) }, { code: error.code, message: error.message, ...probe });
      continue;
    }
    if (data) {
      row = data as { response_json: unknown; error_kind: ErrorKind | null; latency_ms: number | null };
      break;
    }
  }
  if (!row) {
    return {
      errorKind: 'OTHER',
      rawResponse: 'no fixture',
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: `OCR_MOCK_MODE: no fixture for ${p.item.storage_path} (provider=${p.provider}, model=${p.model})`,
      latencyMs: 0,
    };
  }
  const latencyMs = row.latency_ms ?? 0;
  if (row.error_kind && row.error_kind !== 'OK') {
    return {
      errorKind: row.error_kind,
      rawResponse: JSON.stringify(row.response_json ?? {}),
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: `OCR_MOCK_MODE: forced ${row.error_kind}`,
      latencyMs,
    };
  }
  const text = JSON.stringify(row.response_json ?? {});
  const usage = (row.response_json && typeof row.response_json === 'object'
    ? (row.response_json as Record<string, unknown>).__mock_usage
    : null) as { prompt_tokens?: number; completion_tokens?: number } | null;
  return {
    errorKind: 'OK',
    rawResponse: text,
    text,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    latencyMs,
  };
}
