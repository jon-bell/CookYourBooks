// User-tunable list of OCR bakeoff variants. Persisted to localStorage so
// the user doesn't lose their carefully-tuned matrix between sessions.
// Lives here (next to the legacy OCR settings) rather than in Supabase
// because variants reference the same in-browser API key the regular OCR
// path uses.

import type { BakeoffVariant } from '../import/bakeoff.js';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROMPT,
  type OcrProvider,
} from './ocrSettings.js';

const KEY = 'cookyourbooks.bakeoff.v1';

/**
 * Seed matrix the form shows on first visit. Two cheap-vs-rich Gemini
 * models is a sensible default — it's a clear apples-to-apples
 * comparison without forcing the user to know a second provider.
 */
export const DEFAULT_VARIANTS: readonly BakeoffVariant[] = [
  {
    id: 'seed-flash',
    name: 'Gemini Flash',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    prompt: DEFAULT_PROMPT,
  },
  {
    id: 'seed-pro',
    name: 'Gemini Pro',
    provider: 'gemini',
    model: DEFAULT_MODEL_BY_PROVIDER.gemini,
    prompt: DEFAULT_PROMPT,
  },
];

export function loadBakeoffVariants(): BakeoffVariant[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_VARIANTS.map(clone);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_VARIANTS.map(clone);
    }
    return parsed.flatMap((v) => (isVariant(v) ? [v] : []));
  } catch {
    return DEFAULT_VARIANTS.map(clone);
  }
}

export function saveBakeoffVariants(variants: readonly BakeoffVariant[]): void {
  localStorage.setItem(KEY, JSON.stringify(variants));
}

export function newVariant(seed?: Partial<BakeoffVariant>): BakeoffVariant {
  const provider: OcrProvider = seed?.provider ?? 'gemini';
  return {
    id: crypto.randomUUID(),
    name: seed?.name ?? 'New variant',
    provider,
    model: seed?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider],
    prompt: seed?.prompt ?? DEFAULT_PROMPT,
    baseUrl: seed?.baseUrl,
  };
}

function clone(v: BakeoffVariant): BakeoffVariant {
  return { ...v };
}

function isVariant(v: unknown): v is BakeoffVariant {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    (o.provider === 'gemini' || o.provider === 'openai-compatible') &&
    typeof o.model === 'string' &&
    typeof o.prompt === 'string'
  );
}
