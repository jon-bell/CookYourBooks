// LLM pricing for OCR cost computation.
//
// Source of truth at runtime is the `model_pricing` table, refreshed from
// models.dev (primary) + OpenRouter (fallback). The bundled pricing.json is
// the offline seed + fallback. A model missing from BOTH is logged loudly —
// never silently billed at $0 (the old behaviour, which made every
// unmapped-model import read as free).
import pricingCard from './pricing.json' with { type: 'json' };

export interface Rate {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}
interface PricingEntry extends Rate {
  provider: string;
  model: string;
}
interface PricingCard {
  entries: PricingEntry[];
  fallback: Rate;
}
const BUNDLED = pricingCard as PricingCard;

export type RateMap = Map<string, Rate>;
const key = (provider: string, model: string): string => `${provider}:${model}`;

const STALE_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_URL = 'https://models.dev/api.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
// Models with no exact match in the pricing sources, proxied to the closest.
const PROXY: Record<string, string> = {
  'gemini-3-pro-image-preview': 'gemini-3-pro-preview',
};

interface Logger {
  info: (m: string, extra?: Record<string, unknown>) => void;
  warn: (m: string, extra?: Record<string, unknown>) => void;
  error: (m: string, extra?: Record<string, unknown>) => void;
}

export function seedFromBundled(): RateMap {
  const m: RateMap = new Map();
  for (const e of BUNDLED.entries) {
    m.set(key(e.provider, e.model), {
      input_usd_per_mtok: e.input_usd_per_mtok,
      output_usd_per_mtok: e.output_usd_per_mtok,
    });
  }
  return m;
}

/** Pure cost math: tokens × rate → integer micro-USD. Loud on a true miss. */
export function costFromMap(
  map: RateMap,
  provider: string,
  model: string,
  prompt: number,
  completion: number,
): number {
  const rate = map.get(key(provider, model));
  if (!rate) {
    // Never silently bill $0 — surface the gap so a missing model is fixed.
    console.error(`[pricing] MISSING rate for ${provider}/${model} — billing $0`);
    const fb = BUNDLED.fallback;
    return Math.round(
      ((prompt * fb.input_usd_per_mtok + completion * fb.output_usd_per_mtok) / 1_000_000) *
        1_000_000,
    );
  }
  return Math.round(
    ((prompt * rate.input_usd_per_mtok + completion * rate.output_usd_per_mtok) / 1_000_000) *
      1_000_000,
  );
}

// models.dev shape: { "<vendor>": { "models": { "<id>": { "cost": { "input", "output" } } } } }
// cost.input / cost.output are already USD per 1M tokens.
function rateFromModelsDev(json: unknown, model: string): Rate | null {
  if (!json || typeof json !== 'object') return null;
  for (const vendor of Object.values(json as Record<string, unknown>)) {
    const models = (vendor as { models?: Record<string, unknown> })?.models;
    const hit = models?.[model] as { cost?: { input?: number; output?: number } } | undefined;
    const c = hit?.cost;
    if (c && typeof c.input === 'number' && typeof c.output === 'number') {
      return { input_usd_per_mtok: c.input, output_usd_per_mtok: c.output };
    }
  }
  return null;
}

// OpenRouter shape: { data: [ { id: "vendor/model[-date]", pricing: { prompt, completion } } ] }
// pricing.prompt / .completion are per-token decimal strings.
function rateFromOpenRouter(json: unknown, provider: string, model: string): Rate | null {
  const prefix = provider === 'gemini' ? 'google/' : 'openai/';
  const candidate = prefix + model;
  const data = (json as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> })?.data;
  for (const e of data ?? []) {
    const id = e?.id ?? '';
    const base = id.split('/')[1] ?? '';
    if (id === candidate || base === model || base.startsWith(model + '-')) {
      const p = parseFloat(e?.pricing?.prompt ?? '');
      const c = parseFloat(e?.pricing?.completion ?? '');
      if (Number.isFinite(p) && Number.isFinite(c)) {
        return { input_usd_per_mtok: p * 1e6, output_usd_per_mtok: c * 1e6 };
      }
    }
  }
  return null;
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<unknown | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
async function refreshPricing(db: any, log: Logger): Promise<void> {
  const md = await fetchJson(MODELS_DEV_URL);
  let or: unknown | null = null;
  const rows: Array<PricingEntry & { source: string }> = [];
  for (const e of BUNDLED.entries) {
    const lookup = PROXY[e.model] ?? e.model;
    let rate = md ? rateFromModelsDev(md, lookup) : null;
    let source = 'models.dev';
    if (!rate) {
      if (or === null) or = (await fetchJson(OPENROUTER_URL)) ?? false;
      if (or) {
        rate = rateFromOpenRouter(or, e.provider, e.model);
        source = 'openrouter';
      }
    }
    if (rate) {
      rows.push({ provider: e.provider, model: e.model, ...rate, source });
    }
  }
  if (rows.length === 0) {
    log.warn('pricing refresh: no rows fetched (sources unreachable?)');
    return;
  }
  const { error } = await db
    .from('model_pricing')
    .upsert(
      rows.map((r) => ({ ...r, fetched_at: new Date().toISOString() })),
      { onConflict: 'provider,model' },
    );
  if (error) log.warn('pricing upsert failed', { error: error.message });
  else log.info('pricing refreshed', { count: rows.length });
}

/**
 * Build the rate map: bundled seed overlaid by the model_pricing table,
 * refreshing from the network when the table is empty or stale. Best-effort
 * — any failure leaves the bundled snapshot in place. Skips the network in
 * mock/CI mode (opts.mock) so tests stay offline + deterministic.
 */
// deno-lint-ignore no-explicit-any
export async function loadPricing(db: any, log: Logger, opts: { mock: boolean }): Promise<RateMap> {
  const map = seedFromBundled();
  const overlay = async (): Promise<{ count: number; newest: number }> => {
    const { data } = await db
      .from('model_pricing')
      .select('provider, model, input_usd_per_mtok, output_usd_per_mtok, fetched_at');
    let newest = 0;
    for (const r of data ?? []) {
      map.set(key(r.provider, r.model), {
        input_usd_per_mtok: Number(r.input_usd_per_mtok),
        output_usd_per_mtok: Number(r.output_usd_per_mtok),
      });
      newest = Math.max(newest, Date.parse(r.fetched_at));
    }
    return { count: data?.length ?? 0, newest };
  };
  try {
    const first = await overlay();
    if (!opts.mock && (first.count === 0 || Date.now() - first.newest > STALE_MS)) {
      await refreshPricing(db, log).catch((e) => log.warn('pricing refresh failed', { error: String(e) }));
      await overlay();
    }
  } catch (e) {
    log.warn('pricing load failed; using bundled snapshot', { error: String(e) });
  }
  return map;
}
