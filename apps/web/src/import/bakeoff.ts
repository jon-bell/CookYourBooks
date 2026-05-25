import { formatQuantity, type ParsedRecipeDraft } from '@cookyourbooks/domain';
import { ocrWithLlmDiagnostic, type LlmUsage } from './llm.js';
import { costUsdMicros } from './pricing.js';
import type { OcrProvider, OcrSettings } from '../settings/ocrSettings.js';

export interface BakeoffVariant {
  id: string;
  name: string;
  provider: OcrProvider;
  model: string;
  prompt: string;
  /** Only meaningful for `openai-compatible`. Falls back to the global setting. */
  baseUrl?: string;
}

export interface BakeoffSuccess {
  variantId: string;
  status: 'ok';
  drafts: ParsedRecipeDraft[];
  rawText: string;
  usage: LlmUsage;
  costUsdMicros: number;
  elapsedMs: number;
}

export interface BakeoffFailure {
  variantId: string;
  status: 'error';
  error: string;
  elapsedMs: number;
}

export type BakeoffResult = BakeoffSuccess | BakeoffFailure;

/**
 * E2E hook: replaces the real per-variant LLM call. Tests register a shim
 * keyed by variant id, and the runner uses it instead of going to the
 * network. Same idea as `window.__cybOcrShim` but per variant so the same
 * image can produce different outputs for each row in the comparison
 * matrix.
 */
export type BakeoffShim = (
  variant: BakeoffVariant,
  source: Blob | File,
) => Promise<{
  drafts: ParsedRecipeDraft[];
  rawText: string;
  usage: LlmUsage;
  /** Optional override; if absent the runner measures real wall time. */
  elapsedMs?: number;
}>;

declare global {
  interface Window {
    __cybBakeoffShim?: BakeoffShim;
  }
}

/**
 * Run one variant. Captures wall time on both success and failure so the
 * grid can still show how long a failed call took to fall over. The API
 * key + baseUrl come from the user's saved `OcrSettings` — the bakeoff
 * page never asks the user to re-enter a key.
 */
export async function runBakeoffVariant(
  variant: BakeoffVariant,
  source: Blob | File,
  apiKey: string,
): Promise<BakeoffResult> {
  const started = performance.now();
  try {
    const shim = typeof window !== 'undefined' ? window.__cybBakeoffShim : undefined;
    if (shim) {
      const r = await shim(variant, source);
      const elapsedMs = r.elapsedMs ?? Math.round(performance.now() - started);
      return {
        variantId: variant.id,
        status: 'ok',
        drafts: r.drafts,
        rawText: r.rawText,
        usage: r.usage,
        costUsdMicros: costUsdMicros(
          variant.provider,
          variant.model,
          r.usage.promptTokens,
          r.usage.completionTokens,
        ),
        elapsedMs,
      };
    }
    const settings: OcrSettings = {
      provider: variant.provider,
      apiKey,
      model: variant.model,
      baseUrl: variant.baseUrl,
      prompt: variant.prompt,
    };
    const r = await ocrWithLlmDiagnostic(source, settings);
    const elapsedMs = Math.round(performance.now() - started);
    return {
      variantId: variant.id,
      status: 'ok',
      drafts: r.drafts,
      rawText: r.rawText,
      usage: r.usage,
      costUsdMicros: costUsdMicros(
        variant.provider,
        variant.model,
        r.usage.promptTokens,
        r.usage.completionTokens,
      ),
      elapsedMs,
    };
  } catch (err) {
    return {
      variantId: variant.id,
      status: 'error',
      error: (err as Error).message,
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}

/**
 * Run every variant against the same image. Calls fire in parallel so the
 * total wall time of the bakeoff is the slowest variant, not the sum.
 * Per-variant `onUpdate` lets the UI stream results in as they land — a
 * fast cheap model shouldn't have to wait for an expensive one to render.
 */
export async function runBakeoff(
  variants: readonly BakeoffVariant[],
  source: Blob | File,
  apiKey: string,
  onUpdate?: (result: BakeoffResult) => void,
): Promise<BakeoffResult[]> {
  const promises = variants.map(async (v) => {
    const r = await runBakeoffVariant(v, source, apiKey);
    onUpdate?.(r);
    return r;
  });
  return Promise.all(promises);
}

/**
 * Render a draft into a short canonical text blob suitable for a textual
 * diff. We deliberately serialize only the user-visible fields (title,
 * yield, ingredient list, instruction text) so a diff doesn't flag noise
 * like model-minted ingredient ids that change every run.
 */
export function summarizeDraftForDiff(draft: ParsedRecipeDraft): string {
  const lines: string[] = [];
  lines.push(`Title: ${draft.title ?? '(none)'}`);
  if (draft.bookTitle) lines.push(`Book: ${draft.bookTitle}`);
  if (draft.pageNumbers && draft.pageNumbers.length > 0)
    lines.push(`Pages: ${draft.pageNumbers.join(', ')}`);
  if (draft.servings) {
    const s = draft.servings;
    const range =
      s.amountMax !== undefined ? `${s.amount}–${s.amountMax}` : `${s.amount}`;
    lines.push(`Yield: ${range} ${s.description ?? 'servings'}`);
  }
  if (draft.timeEstimate) lines.push(`Time: ${draft.timeEstimate}`);
  lines.push('');
  lines.push('Ingredients:');
  for (const ing of draft.ingredients) {
    if (ing.type === 'MEASURED') {
      lines.push(`  - ${formatQuantity(ing.quantity)} ${ing.name}`);
    } else {
      lines.push(`  - ${ing.name}${ing.description ? ` (${ing.description})` : ''}`);
    }
  }
  lines.push('');
  lines.push('Steps:');
  for (const step of draft.instructions) {
    lines.push(`  ${step.stepNumber}. ${step.text}`);
  }
  return lines.join('\n');
}

/** Per-line diff hunk used by the comparison view. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/**
 * Tiny LCS-based line diff. The full diff library set in npm pulls a lot
 * of weight for this single view; an inline ~40 LOC implementation is fine
 * for the relatively short draft summaries we feed it.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const m = aLines.length;
  const n = bLines.length;
  // Standard LCS length table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      out.push({ kind: 'same', text: aLines[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: aLines[i]! });
      i++;
    } else {
      out.push({ kind: 'add', text: bLines[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', text: aLines[i++]! });
  while (j < n) out.push({ kind: 'add', text: bLines[j++]! });
  return out;
}
