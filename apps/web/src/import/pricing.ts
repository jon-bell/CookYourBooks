// Single source of truth for OCR pricing lives in
// `supabase/functions/import-worker/pricing.json` — the Edge Function
// reads it directly (Deno JSON import), and Vite resolves it here.
// Bumping a rate is one file change instead of two.
import card from '../../../../supabase/functions/import-worker/pricing.json' with { type: 'json' };

export type OcrProviderId = 'gemini' | 'openai-compatible';

export interface PricingEntry {
  provider: OcrProviderId;
  model: string;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

interface RawCard {
  entries: ReadonlyArray<{
    provider: string;
    model: string;
    input_usd_per_mtok: number;
    output_usd_per_mtok: number;
  }>;
  fallback: { input_usd_per_mtok: number; output_usd_per_mtok: number };
}

const raw = card as RawCard;

export const PRICING: readonly PricingEntry[] = raw.entries.map((e) => ({
  provider: e.provider as OcrProviderId,
  model: e.model,
  input_usd_per_mtok: e.input_usd_per_mtok,
  output_usd_per_mtok: e.output_usd_per_mtok,
}));

export const PRICING_FALLBACK = {
  input_usd_per_mtok: raw.fallback.input_usd_per_mtok,
  output_usd_per_mtok: raw.fallback.output_usd_per_mtok,
} as const;

export function findRate(
  provider: OcrProviderId,
  model: string,
): { input_usd_per_mtok: number; output_usd_per_mtok: number } {
  const hit = PRICING.find((p) => p.provider === provider && p.model === model);
  if (hit) return { input_usd_per_mtok: hit.input_usd_per_mtok, output_usd_per_mtok: hit.output_usd_per_mtok };
  return PRICING_FALLBACK;
}

export function costUsdMicros(
  provider: OcrProviderId,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rate = findRate(provider, model);
  const usd =
    (promptTokens * rate.input_usd_per_mtok + completionTokens * rate.output_usd_per_mtok) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}
