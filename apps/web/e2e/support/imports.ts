import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE } from './env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(__dirname, '../fixtures');

const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export interface FakeIngredient {
  type: 'MEASURED' | 'VAGUE';
  name: string;
  quantity?: {
    type: 'EXACT' | 'FRACTIONAL' | 'RANGE';
    amount?: number;
    whole?: number;
    numerator?: number;
    denominator?: number;
    min?: number;
    max?: number;
    unit: string;
  };
}

export interface FakeInstruction {
  stepNumber: number;
  text: string;
}

export interface FakeRecipeDraft {
  title?: string;
  servings?: { amount: number };
  ingredients?: FakeIngredient[];
  instructions?: FakeInstruction[];
  bookTitle?: string;
  pageNumbers?: number[];
}

export interface TocEntryInput {
  title: string;
  pageNumber?: number;
}

export interface SeedFixtureArgs {
  storagePath: string;
  kind: 'recipe' | 'toc' | 'recitation' | 'auth-fail';
  draft?: FakeRecipeDraft;
  /**
   * For multi-recipe responses (e.g. a cookbook spread). When set the
   * response payload uses the `{ recipes: [...] }` wrapper shape so the
   * worker's parser returns multiple drafts.
   */
  drafts?: FakeRecipeDraft[];
  entries?: TocEntryInput[];
  latencyMs?: number;
  /**
   * Provider this fixture row covers. Empty string matches any provider
   * — used by single-provider tests that don't care which model the
   * worker thinks it called. Tests exercising the fallback path seed
   * one row per provider so the worker picks up different responses on
   * attempt #1 (default provider) vs attempt #2 (fallback provider).
   */
  provider?: 'gemini' | 'openai-compatible' | '';
  /**
   * Model the fixture is tied to. Empty (default) matches any model for
   * the given provider — the regular bulk-import flow uses this. Bakeoff
   * variants seed a fixture per model so each variant in a run returns
   * a distinct payload; pair with `storagePath: '*'` to be path-agnostic.
   */
  model?: string;
  /**
   * If true, upsert over an existing row. Useful when simulating "the
   * fallback model would have succeeded" by re-seeding the same path
   * after the first attempt routed to NEEDS_FALLBACK.
   */
  upsert?: boolean;
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function seedOcrFixture(args: SeedFixtureArgs): Promise<void> {
  const responseJson = buildResponseJson(args);
  const errorKind = mapErrorKind(args.kind);
  const row = {
    item_storage_path: args.storagePath,
    provider: args.provider ?? '',
    model: args.model ?? '',
    response_json: responseJson,
    error_kind: errorKind,
    latency_ms: args.latencyMs ?? 0,
  };
  const headers = adminHeaders({
    Prefer: args.upsert ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
  });
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/ocr_test_fixtures`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  });
  if (!resp.ok) {
    throw new Error(
      `seedOcrFixture (${args.kind}) for ${args.storagePath} failed: ${resp.status} ${await resp.text()}`,
    );
  }
}

export async function deleteOcrFixture(storagePath: string): Promise<void> {
  await fetch(
    `${SUPABASE_URL}/rest/v1/ocr_test_fixtures?item_storage_path=eq.${encodeURIComponent(storagePath)}`,
    { method: 'DELETE', headers: adminHeaders() },
  );
}

export interface RewriteFixtureSimplifiedStep {
  text: string;
  durationSec?: number;
  temperature?: { value: number; unit: 'FAHRENHEIT' | 'CELSIUS' };
  notes?: string;
}

export interface SeedRewriteFixtureArgs {
  /** Recipe id the fixture is keyed against; `'*'` matches any recipe. */
  recipeId: string;
  /** `''` matches any provider for this recipe. */
  provider?: 'gemini' | 'openai-compatible' | '';
  /** `''` matches any model for this provider. */
  model?: string;
  rewritten?: Array<{
    instructionId: string;
    simplifiedSteps: RewriteFixtureSimplifiedStep[];
  }>;
  /** Force a worker error path instead of OK. */
  errorKind?: 'RECITATION' | 'AUTH' | 'NETWORK' | 'PARSE' | 'TIMEOUT' | 'OTHER';
  latencyMs?: number;
  upsert?: boolean;
}

export async function seedRewriteFixture(args: SeedRewriteFixtureArgs): Promise<void> {
  const responseJson = args.errorKind
    ? {}
    : { rewritten: args.rewritten ?? [] };
  const row = {
    recipe_id: args.recipeId,
    provider: args.provider ?? '',
    model: args.model ?? '',
    response_json: responseJson,
    error_kind: args.errorKind ?? 'OK',
    latency_ms: args.latencyMs ?? 0,
  };
  const headers = adminHeaders({
    Prefer: args.upsert ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
  });
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rewrite_test_fixtures`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  });
  if (!resp.ok) {
    throw new Error(
      `seedRewriteFixture for ${args.recipeId} failed: ${resp.status} ${await resp.text()}`,
    );
  }
}

export interface RemixFixtureRecipe {
  title?: string;
  yield?: { type: string; value: number; unit: string };
  timeEstimate?: string;
  equipment?: string[];
  description?: string;
  ingredients?: unknown[];
  instructions?: unknown[];
}

export interface SeedRemixFixtureArgs {
  /** Recipe id the fixture is keyed against; `'*'` matches any recipe. */
  recipeId: string;
  /** `''` matches any provider for this recipe. */
  provider?: 'gemini' | 'openai-compatible' | '';
  /** `''` matches any model for this provider. */
  model?: string;
  /** The recipe(s) the mock LLM "returns" — the OCR import schema. */
  recipes?: RemixFixtureRecipe[];
  /** Raw response_json override (e.g. non-recipe junk to force an empty draft). */
  responseJson?: unknown;
  /** Force a worker error path instead of OK. */
  errorKind?: 'RECITATION' | 'AUTH' | 'NETWORK' | 'PARSE' | 'TIMEOUT' | 'OTHER';
  latencyMs?: number;
  upsert?: boolean;
}

export async function seedRemixFixture(args: SeedRemixFixtureArgs): Promise<void> {
  const responseJson = args.errorKind
    ? {}
    : args.responseJson ?? { recipes: args.recipes ?? [] };
  const row = {
    recipe_id: args.recipeId,
    provider: args.provider ?? '',
    model: args.model ?? '',
    response_json: responseJson,
    error_kind: args.errorKind ?? 'OK',
    latency_ms: args.latencyMs ?? 0,
  };
  const headers = adminHeaders({
    Prefer: args.upsert ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
  });
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/remix_test_fixtures`, {
    method: 'POST',
    headers,
    body: JSON.stringify(row),
  });
  if (!resp.ok) {
    throw new Error(
      `seedRemixFixture for ${args.recipeId} failed: ${resp.status} ${await resp.text()}`,
    );
  }
}

function buildResponseJson(args: SeedFixtureArgs): Record<string, unknown> {
  if (args.kind === 'recipe' || args.kind === 'recitation' || args.kind === 'auth-fail') {
    if (args.drafts && args.drafts.length > 1) {
      // Multi-recipe responses go through the `{ recipes: [...] }`
      // wrapper so the worker's parser returns multiple drafts.
      return {
        recipes: args.drafts.map(serializeDraft),
        __mock_usage: { prompt_tokens: 100, completion_tokens: 200 },
      };
    }
    const d = args.drafts?.[0] ?? args.draft ?? defaultDraft();
    return {
      ...serializeDraft(d),
      __mock_usage: { prompt_tokens: 100, completion_tokens: 200 },
    };
  }
  if (args.kind === 'toc') {
    return {
      entries: (args.entries ?? []).map((e) => ({
        title: e.title,
        page_number: e.pageNumber ?? null,
      })),
      __mock_usage: { prompt_tokens: 50, completion_tokens: 80 },
    };
  }
  return {};
}

function mapErrorKind(kind: SeedFixtureArgs['kind']): string | null {
  switch (kind) {
    case 'recitation':
      return 'RECITATION';
    case 'auth-fail':
      return 'AUTH';
    default:
      return 'OK';
  }
}

function serializeDraft(d: FakeRecipeDraft): Record<string, unknown> {
  return {
    title: d.title,
    yield: d.servings ? { amount: d.servings.amount } : undefined,
    ingredients: (d.ingredients ?? []).map((ing) => ({
      type: ing.type,
      name: ing.name,
      quantity: ing.quantity,
    })),
    instructions: (d.instructions ?? []).map((s) => ({
      stepNumber: s.stepNumber,
      text: s.text,
    })),
    bookTitle: d.bookTitle,
    pageNumbers: d.pageNumbers,
  };
}

function defaultDraft(): FakeRecipeDraft {
  return {
    title: 'Mock Recipe',
    servings: { amount: 4 },
    ingredients: [
      {
        type: 'MEASURED',
        name: 'flour',
        quantity: { type: 'EXACT', amount: 2, unit: 'cup' },
      },
      { type: 'VAGUE', name: 'salt' },
    ],
    instructions: [
      { stepNumber: 1, text: 'Mix dry ingredients.' },
      { stepNumber: 2, text: 'Bake until done.' },
    ],
  };
}

interface ImportItemRow {
  id: string;
  page_index: number;
  storage_path: string;
  status: string;
}

export interface ImportItemAttemptRow {
  id: string;
  item_id: string;
  attempt_no: number;
  provider: string;
  model: string;
  error_kind: string | null;
  error_message: string | null;
}

export async function listItemAttempts(itemId: string): Promise<ImportItemAttemptRow[]> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/import_item_attempts?item_id=eq.${itemId}&select=id,item_id,attempt_no,provider,model,error_kind,error_message&order=attempt_no.asc`,
    { headers: adminHeaders() },
  );
  if (!resp.ok) {
    throw new Error(`listItemAttempts failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as ImportItemAttemptRow[];
}

/**
 * Poll the server until an item's `is_toc` flag matches `expected`. The
 * "This is a Table of Contents page" toggle pushes through the outbox,
 * which can lag the on-page "Synced" badge — tests that then kick the
 * worker need the flag confirmed server-side first, or the worker reads
 * the page as a regular recipe.
 */
export async function waitForItemIsToc(
  itemId: string,
  expected = true,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: boolean | undefined;
  while (Date.now() < deadline) {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/import_items?id=eq.${itemId}&select=is_toc`,
      { headers: adminHeaders() },
    );
    if (resp.ok) {
      const rows = (await resp.json()) as { is_toc: boolean }[];
      last = rows[0]?.is_toc;
      if (last === expected) return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `item ${itemId} is_toc never became ${expected} (last saw ${String(last)})`,
  );
}

export async function listBatchItems(batchId: string): Promise<ImportItemRow[]> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/import_items?batch_id=eq.${batchId}&select=id,page_index,storage_path,status&order=page_index.asc`,
    { headers: adminHeaders() },
  );
  if (!resp.ok) {
    throw new Error(`listBatchItems failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as ImportItemRow[];
}

export async function waitForBatchItemCount(
  batchId: string,
  expectedCount: number,
  timeoutMs = 15_000,
): Promise<ImportItemRow[]> {
  const deadline = Date.now() + timeoutMs;
  let last: ImportItemRow[] = [];
  while (Date.now() < deadline) {
    last = await listBatchItems(batchId);
    if (last.length === expectedCount) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Expected ${expectedCount} items in batch ${batchId}, last saw ${last.length}: ${JSON.stringify(last.map((r) => r.status))}`,
  );
}

export interface ItemStatusCounts {
  pending: number;
  claimed: number;
  ocrDone: number;
  needsFallback: number;
  failed: number;
  reviewed: number;
  discarded: number;
}

async function fetchStatusCounts(batchId: string): Promise<ItemStatusCounts> {
  const rows = await listBatchItems(batchId);
  const c: ItemStatusCounts = {
    pending: 0,
    claimed: 0,
    ocrDone: 0,
    needsFallback: 0,
    failed: 0,
    reviewed: 0,
    discarded: 0,
  };
  for (const r of rows) {
    switch (r.status) {
      case 'PENDING':
        c.pending += 1;
        break;
      case 'CLAIMED':
        c.claimed += 1;
        break;
      case 'OCR_DONE':
        c.ocrDone += 1;
        break;
      case 'NEEDS_FALLBACK':
        c.needsFallback += 1;
        break;
      case 'OCR_FAILED':
        c.failed += 1;
        break;
      case 'REVIEWED':
        c.reviewed += 1;
        break;
      case 'DISCARDED':
        c.discarded += 1;
        break;
    }
  }
  return c;
}

export async function waitForItemStatuses(
  batchId: string,
  predicate: (counts: ItemStatusCounts) => boolean,
  timeoutMs = 60_000,
): Promise<ItemStatusCounts> {
  const deadline = Date.now() + timeoutMs;
  let last: ItemStatusCounts | undefined;
  while (Date.now() < deadline) {
    last = await fetchStatusCounts(batchId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForItemStatuses timeout. Last: ${JSON.stringify(last)}`);
}

/**
 * Drive the file input on /import/new. The actual `<input type=file>` is
 * hidden behind a "Choose images" button — we set files directly on the
 * input rather than clicking through the chooser dialog.
 */
export async function uploadTestImages(page: Page, fileNames: string[]): Promise<void> {
  const buffers = fileNames.map((name) => ({
    name,
    mimeType: name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png',
    buffer: readFileSync(resolve(FIXTURES_DIR, name)),
  }));
  const accept = fileNames.some((n) => n.toLowerCase().endsWith('.pdf'))
    ? 'application/pdf'
    : 'image/*';
  await page
    .locator(`input[type="file"][accept="${accept}"]`)
    .setInputFiles(buffers);
}

/**
 * Install `window.__cybScanShim` so the live-viewfinder camera
 * (CameraScanner) is bypassed and `scanPages()` returns canned page images
 * instead. Registered via `addInitScript` so it survives the navigation to
 * /import/scan. The bytes are real PNG fixtures so the upload pipeline's
 * `prepareImage` decode succeeds.
 */
export async function installScanShim(page: Page, fileNames: string[]): Promise<void> {
  const files = fileNames.map((name) => ({
    name,
    type: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
    base64: readFileSync(resolve(FIXTURES_DIR, name)).toString('base64'),
  }));
  await page.addInitScript((items: { name: string; type: string; base64: string }[]) => {
    function b64ToFile(it: { name: string; type: string; base64: string }): File {
      const bin = atob(it.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], it.name, { type: it.type });
    }
    (window as unknown as { __cybScanShim?: () => Promise<File[]> }).__cybScanShim = async () =>
      items.map(b64ToFile);
  }, files);
}

export async function triggerWorker(batchId?: string | null): Promise<{
  processed: number;
  failed: number;
  parked: number;
  remaining: number;
}> {
  const resp = await fetch(`${FUNCTIONS_URL}/import-worker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
    body: JSON.stringify({ batch_id: batchId ?? null }),
  });
  if (!resp.ok) {
    throw new Error(`triggerWorker failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()) as {
    processed: number;
    failed: number;
    parked: number;
    remaining: number;
  };
}

/**
 * Kick the worker repeatedly until either the queue drains some work or
 * we hit `maxAttempts`. Used by tests that drive the UI through the
 * full upload pipeline — the page does its own ocr_kick but the test
 * env doesn't have the worker vault secret, and the outbox push that
 * makes the row visible server-side is asynchronous.
 */
export async function pumpWorker(maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await triggerWorker();
    if (r.processed > 0 || r.failed > 0 || r.parked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Convenience: configure an OCR key via the on-page Supabase client.
 * Mock mode means the key value is irrelevant; the UI just gates batch
 * creation on "a key exists".
 */
export async function configureOcrKey(
  page: Page,
  provider: 'gemini' | 'openai-compatible',
  rawKey = 'fake-key-1234',
): Promise<void> {
  const result = await page.evaluate(
    async ({ p, k }) => {
      const sb = window.__cybSupabase;
      if (!sb) return { ok: false, message: '__cybSupabase missing' };
      const { error } = await sb.rpc('ocr_key_set', {
        p_provider: p,
        p_raw_key: k,
      });
      return { ok: !error, message: error?.message ?? '' };
    },
    { p: provider, k: rawKey },
  );
  if (!result.ok) {
    throw new Error(`configureOcrKey(${provider}): ${result.message}`);
  }
}

/**
 * Wait for a batch's local-DB-backed counts to match the expected totals.
 * Polls the batch board page footer / items list rather than fetching from
 * Supabase directly — that way realtime+sync propagation is exercised.
 */
export async function waitForBatchStatus(
  page: Page,
  batchId: string,
  expected: { done?: number; failed?: number; parked?: number },
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const counts = await fetchStatusCounts(batchId);
        return {
          done: counts.ocrDone + counts.reviewed,
          failed: counts.failed,
          parked: counts.needsFallback,
        };
      },
      {
        message: `waiting for batch ${batchId} counts to match ${JSON.stringify(expected)}`,
        timeout: timeoutMs,
        intervals: [250, 500, 1000],
      },
    )
    .toEqual(expect.objectContaining(expected));
}
