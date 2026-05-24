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
  fallback_model: string | null;
  fallback_provider: Provider | null;
  recitation_policy: 'ASK' | 'FALLBACK' | 'FAIL';
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

const LOOP_BUDGET_MS = 60_000;
const CLAIM_BATCH = 8;
const PARALLEL = 3;
const LEASE_SECONDS = 300;
const MAX_TRANSIENT_RETRIES = 3;
const MAX_PARSE_RETRIES = 2;
const MAX_NETWORK_FETCH_RETRIES = 2;

const SUPABASE_URL = mustEnv('SUPABASE_URL');
const SERVICE_ROLE = mustEnv('SUPABASE_SERVICE_ROLE_KEY');
const MOCK_MODE = Deno.env.get('OCR_MOCK_MODE') === '1';

function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- HTTP entry ----------

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
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
  const summary = await runLoop(workerId, batchId);

  if (summary.remaining > 0) {
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

async function runLoop(workerId: string, batchId: string | null): Promise<LoopSummary> {
  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  let parked = 0;
  let emptyTicks = 0;

  while (Date.now() - startedAt < LOOP_BUDGET_MS) {
    const items = await claimBatch(workerId, batchId);
    if (items.length === 0) {
      emptyTicks++;
      if (emptyTicks >= 2) break;
      continue;
    }
    emptyTicks = 0;

    for (let i = 0; i < items.length; i += PARALLEL) {
      const chunk = items.slice(i, i + PARALLEL);
      const results = await Promise.all(chunk.map((it) => processItem(it, workerId)));
      for (const r of results) {
        if (r === 'OCR_DONE') processed++;
        else if (r === 'NEEDS_FALLBACK') parked++;
        else failed++;
      }
      if (Date.now() - startedAt >= LOOP_BUDGET_MS) break;
    }
  }

  const remaining = await countPending(batchId);
  return { processed, failed, parked, remaining };
}

async function claimBatch(workerId: string, batchId: string | null): Promise<ImportItem[]> {
  const { data, error } = await supabase.rpc('import_claim_next', {
    p_worker_id: workerId,
    p_batch_id: batchId,
    p_lease_seconds: LEASE_SECONDS,
    p_limit: CLAIM_BATCH,
  });
  if (error) {
    console.error('import_claim_next failed', error);
    return [];
  }
  return (data ?? []) as ImportItem[];
}

async function countPending(batchId: string | null): Promise<number> {
  let q = supabase
    .from('import_items')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'PENDING');
  if (batchId) q = q.eq('batch_id', batchId);
  const { count, error } = await q;
  if (error) {
    console.error('countPending failed', error);
    return 0;
  }
  return count ?? 0;
}

// ---------- per-item pipeline ----------

type ItemOutcome = 'OCR_DONE' | 'PENDING' | 'NEEDS_FALLBACK' | 'OCR_FAILED';

async function processItem(item: ImportItem, workerId: string): Promise<ItemOutcome> {
  const claimToken = workerId;

  const batch = await loadBatch(item.batch_id);
  if (!batch) {
    await failItem(item, claimToken, {
      provider: '',
      model: '',
      errorKind: 'OTHER',
      errorMessage: 'Batch missing.',
      rawResponse: '',
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
    }, 'OCR_FAILED');
    return 'OCR_FAILED';
  }

  // `needs_fallback` is the server's hint that a previous attempt
  // tripped the recitation guardrail and the user (or the batch policy)
  // opted into the fallback model. The legacy item.status === 'NEEDS_FALLBACK'
  // check is preserved as a defensive synonym — in practice the
  // import_set_recitation_policy RPC moves the row back to PENDING
  // before the worker reclaims it.
  const useFallback = item.needs_fallback === true || item.status === 'NEEDS_FALLBACK';
  if (useFallback) {
    if (!batch.fallback_provider || !batch.fallback_model) {
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
      );
      return 'OCR_FAILED';
    }
  }
  const provider = useFallback ? batch.fallback_provider! : batch.default_provider;
  const model = useFallback ? batch.fallback_model! : batch.default_model;
  if (!model) {
    await failItem(item, claimToken, mkAttempt(provider, model, 'OTHER', 'No model configured on batch.', '', 0, 0, 0), 'OCR_FAILED');
    return 'OCR_FAILED';
  }

  // Key lookup.
  let key: UserKey | null = null;
  try {
    key = await loadUserKey(item.owner_id, provider);
  } catch (err) {
    console.error('loadUserKey threw', err);
  }
  if (!key && !MOCK_MODE) {
    const message = useFallback
      ? 'Fallback model not configured (set one in Settings)'
      : `No API key configured for ${provider}. Add it in Settings.`;
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'AUTH', message, '', 0, 0, 0),
      'OCR_FAILED',
    );
    return 'OCR_FAILED';
  }

  // Image fetch (with up to 2 retries on transient).
  let imageBytes: Uint8Array | null = null;
  let imageMime = 'image/jpeg';
  let fetchAttempt = 0;
  let fetchError: string | undefined;
  while (fetchAttempt <= MAX_NETWORK_FETCH_RETRIES) {
    try {
      const fetched = await fetchImage(item.owner_id, item.storage_path);
      imageBytes = fetched.bytes;
      imageMime = fetched.mime;
      break;
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
      fetchAttempt++;
    }
  }
  if (!imageBytes) {
    const nextState: 'PENDING' | 'OCR_FAILED' =
      item.attempts < MAX_NETWORK_FETCH_RETRIES ? 'PENDING' : 'OCR_FAILED';
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'NETWORK', `Image fetch failed: ${fetchError ?? 'unknown'}`, '', 0, 0, 0),
      nextState,
    );
    return nextState as ItemOutcome;
  }

  // OCR call (with possible in-invocation FALLBACK on recitation).
  const result = await runOrMock({
    item,
    provider,
    model,
    apiKey: key?.apiKey ?? '',
    baseUrl: key?.baseUrl ?? undefined,
    prompt: item.is_toc ? TOC_PROMPT : RECIPE_PROMPT,
    imageBase64: bytesToBase64(imageBytes),
    mimeType: imageMime,
  });

  // Recitation routing.
  if (result.errorKind === 'RECITATION') {
    return await handleRecitation(item, batch, claimToken, provider, model, imageBytes, imageMime, result);
  }

  // Transient errors.
  if (result.errorKind === 'RATE_LIMIT' || result.errorKind === 'NETWORK' || result.errorKind === 'TIMEOUT') {
    const rawPath = await uploadRaw(item, result.rawResponse);
    const nextState = item.attempts < MAX_TRANSIENT_RETRIES ? 'PENDING' : 'OCR_FAILED';
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, result.errorKind, result.errorMessage ?? result.errorKind, rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      nextState,
    );
    return nextState as ItemOutcome;
  }

  if (result.errorKind === 'AUTH' || result.errorKind === 'OTHER') {
    const rawPath = await uploadRaw(item, result.rawResponse);
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, result.errorKind, result.errorMessage ?? result.errorKind, rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      'OCR_FAILED',
    );
    return 'OCR_FAILED';
  }

  // Parse + persist.
  return await parseAndComplete(item, batch, claimToken, provider, model, result);
}

async function handleRecitation(
  item: ImportItem,
  batch: ImportBatch,
  claimToken: string,
  provider: Provider,
  model: string,
  imageBytes: Uint8Array,
  imageMime: string,
  result: Awaited<ReturnType<typeof runOrMock>>,
): Promise<ItemOutcome> {
  const rawPath = await uploadRaw(item, result.rawResponse);

  if (batch.recitation_policy === 'ASK') {
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'RECITATION', result.errorMessage ?? 'Model declined due to recitation guardrail.', rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      'NEEDS_FALLBACK',
    );
    return 'NEEDS_FALLBACK';
  }

  if (batch.recitation_policy === 'FAIL') {
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'RECITATION', result.errorMessage ?? 'Recitation; policy=FAIL.', rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      'OCR_FAILED',
    );
    return 'OCR_FAILED';
  }

  // FALLBACK: retry inline with the fallback config, if one is set.
  const fbProvider = batch.fallback_provider;
  const fbModel = batch.fallback_model;
  if (!fbProvider || !fbModel) {
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'RECITATION', 'Recitation; no fallback configured.', rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      'OCR_FAILED',
    );
    return 'OCR_FAILED';
  }
  const fbKey = await loadUserKey(item.owner_id, fbProvider);
  if (!fbKey && !MOCK_MODE) {
    await failItem(
      item,
      claimToken,
      mkAttempt(fbProvider, fbModel, 'AUTH', `No API key configured for fallback provider ${fbProvider}.`, rawPath, 0, 0, 0),
      'OCR_FAILED',
    );
    return 'OCR_FAILED';
  }

  const fbResult = await runOrMock({
    item,
    provider: fbProvider,
    model: fbModel,
    apiKey: fbKey?.apiKey ?? '',
    baseUrl: fbKey?.baseUrl ?? undefined,
    prompt: item.is_toc ? TOC_PROMPT : RECIPE_PROMPT,
    imageBase64: bytesToBase64(imageBytes),
    mimeType: imageMime,
  });
  const fbRawPath = await uploadRaw(item, fbResult.rawResponse);

  if (fbResult.errorKind === 'OK') {
    return await parseAndComplete(item, batch, claimToken, fbProvider, fbModel, { ...fbResult, rawResponsePath: fbRawPath });
  }
  if (fbResult.errorKind === 'RECITATION') {
    await failItem(
      item,
      claimToken,
      mkAttempt(fbProvider, fbModel, 'RECITATION', 'Fallback also tripped recitation.', fbRawPath, fbResult.promptTokens, fbResult.completionTokens, fbResult.latencyMs),
      'OCR_FAILED',
    );
    return 'OCR_FAILED';
  }
  // Other errors on fallback: terminal.
  await failItem(
    item,
    claimToken,
    mkAttempt(fbProvider, fbModel, fbResult.errorKind, fbResult.errorMessage ?? fbResult.errorKind, fbRawPath, fbResult.promptTokens, fbResult.completionTokens, fbResult.latencyMs),
    'OCR_FAILED',
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
): Promise<ItemOutcome> {
  const rawPath = result.rawResponsePath ?? (await uploadRaw(item, result.rawResponse));
  const text = result.text ?? '';

  let drafts: ParsedRecipeDraft[] = [];
  let tocEntries: TocEntry[] = [];
  try {
    if (item.is_toc) {
      tocEntries = parseTocJson(text);
    } else {
      drafts = parseLlmJson(text);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const nextState: 'PENDING' | 'OCR_FAILED' =
      item.attempts < MAX_PARSE_RETRIES ? 'PENDING' : 'OCR_FAILED';
    await failItem(
      item,
      claimToken,
      mkAttempt(provider, model, 'PARSE', msg, rawPath, result.promptTokens, result.completionTokens, result.latencyMs),
      nextState,
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
      if (error) console.error('toc_entries insert', error);
    }
  }

  const { data: ok, error } = await supabase.rpc('import_complete', {
    p_item_id: item.id,
    p_claim_token: claimToken,
    p_attempt: attemptPayload,
    p_parsed_drafts: drafts,
  });
  if (error) {
    console.error('import_complete error', error);
    return 'OCR_FAILED';
  }
  if (!ok) {
    console.warn('import_complete returned false (lease lost)', item.id);
  }
  return 'OCR_DONE';
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
): Promise<void> {
  const { data: ok, error } = await supabase.rpc('import_fail', {
    p_item_id: item.id,
    p_claim_token: claimToken,
    p_attempt: attempt,
    p_next_state: nextState,
  });
  if (error) {
    console.error('import_fail error', error);
    return;
  }
  if (!ok) console.warn('import_fail returned false (lease lost)', item.id);
}

async function loadBatch(batchId: string): Promise<ImportBatch | null> {
  const { data, error } = await supabase
    .from('import_batches')
    .select('id, owner_id, default_model, default_provider, fallback_model, fallback_provider, recitation_policy')
    .eq('id', batchId)
    .maybeSingle();
  if (error) {
    console.error('loadBatch', error);
    return null;
  }
  return (data as ImportBatch | null) ?? null;
}

async function loadUserKey(ownerId: string, provider: Provider): Promise<UserKey | null> {
  // user_ocr_keys has the vault_secret_id; vault.decrypted_secrets has
  // the raw key. Service role can read both directly.
  const { data: keyRow, error: keyErr } = await supabase
    .schema('public')
    .from('user_ocr_keys')
    .select('vault_secret_id, base_url')
    .eq('owner_id', ownerId)
    .eq('provider', provider)
    .maybeSingle();
  if (keyErr || !keyRow) {
    if (keyErr) console.error('user_ocr_keys read', keyErr);
    return null;
  }
  const row = keyRow as { vault_secret_id: string; base_url: string | null };
  const { data: secret, error: secretErr } = await supabase
    .schema('vault' as never)
    .from('decrypted_secrets')
    .select('decrypted_secret')
    .eq('id', row.vault_secret_id)
    .maybeSingle();
  if (secretErr || !secret) {
    console.error('decrypt secret', secretErr);
    return null;
  }
  const decrypted = (secret as { decrypted_secret: string }).decrypted_secret;
  return { apiKey: decrypted, baseUrl: row.base_url };
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

async function uploadRaw(item: ImportItem, body: string): Promise<string> {
  const attemptUuid = crypto.randomUUID();
  const path = `${item.owner_id}/${item.batch_id}/raw/${attemptUuid}.txt`;
  const { error } = await supabase.storage
    .from('imports')
    .upload(path, new Blob([body], { type: 'text/plain' }), { upsert: false });
  if (error) {
    console.error('uploadRaw', error);
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
  }).catch((err) => console.warn('self-invoke failed', err));
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
  item: ImportItem;
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  prompt: string;
  imageBase64: string;
  mimeType: string;
}): Promise<OcrCallLike> {
  if (!MOCK_MODE) {
    return await runOcr({
      provider: p.provider,
      model: p.model,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      prompt: p.prompt,
      imageBase64: p.imageBase64,
      mimeType: p.mimeType,
    });
  }

  // First try a provider-specific fixture; if none, fall back to the
  // empty-provider sentinel row so older tests that didn't specify a
  // provider keep working.
  let row: { response_json: unknown; error_kind: ErrorKind | null; latency_ms: number | null } | null = null;
  for (const probe of [p.provider, '']) {
    const { data, error } = await supabase
      .from('ocr_test_fixtures')
      .select('response_json, error_kind, latency_ms')
      .eq('item_storage_path', p.item.storage_path)
      .eq('provider', probe)
      .maybeSingle();
    if (error) {
      console.error('ocr_test_fixtures lookup', error);
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
      errorMessage: `OCR_MOCK_MODE: no fixture for ${p.item.storage_path} (provider=${p.provider})`,
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
