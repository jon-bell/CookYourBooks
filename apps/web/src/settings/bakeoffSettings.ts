// Form-state for the OCR bakeoff variant matrix. Persisted to
// localStorage so the user's last-used set survives navigation, but
// every actual run is server-owned and creates fresh bakeoff_variants
// rows.

import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROMPT, type OcrProvider } from './ocrSettings.js';

/** UI-only variant template. Server-side variants live in
 *  `bakeoff_variants` and have additional result columns. */
export interface LocalBakeoffVariant {
  id: string;
  name: string;
  provider: OcrProvider;
  model: string;
  prompt: string;
  /** Only meaningful for `openai-compatible`. */
  baseUrl?: string;
}

const KEY = 'cookyourbooks.bakeoff.v1';

/** Seed pair shown on first visit — same provider, two models so the
 *  matrix is a clean apples-to-apples comparison without needing
 *  multiple providers configured. */
export const DEFAULT_VARIANTS: readonly LocalBakeoffVariant[] = [
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

export function loadBakeoffVariants(): LocalBakeoffVariant[] {
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

export function saveBakeoffVariants(variants: readonly LocalBakeoffVariant[]): void {
  localStorage.setItem(KEY, JSON.stringify(variants));
}

export function newVariant(seed?: Partial<LocalBakeoffVariant>): LocalBakeoffVariant {
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

function clone(v: LocalBakeoffVariant): LocalBakeoffVariant {
  return { ...v };
}

function isVariant(v: unknown): v is LocalBakeoffVariant {
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
