import type { OcrProvider } from '../import/api.js';

// Pure (React-free) home for the user's localStorage "Fallback model"
// preference. Lives apart from FallbackModelSection.tsx so data-layer
// modules (import/api.ts's getEffectiveOcrConfig) can read it without
// pulling in the React component — and without the api.ts ⇄ component
// import cycle that would create.

const KEY = 'cookyourbooks.ocr.fallback.v1';

/** Snapshotted onto new import batches when the user hasn't saved fallback prefs. */
export const DEFAULT_FALLBACK_PROVIDER: OcrProvider = 'openai-compatible';
export const DEFAULT_FALLBACK_MODEL = 'gpt-5.4';

export interface FallbackPrefs {
  provider: OcrProvider | '';
  model: string;
  /** Named OpenAI-compatible endpoint slug; '' / absent = 'default'.
   *  Pre-endpoint localStorage blobs simply lack the field. */
  endpoint: string;
}

export function loadFallbackPrefs(): FallbackPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return { provider: DEFAULT_FALLBACK_PROVIDER, model: DEFAULT_FALLBACK_MODEL, endpoint: '' };
    }
    const parsed = JSON.parse(raw) as Partial<FallbackPrefs>;
    return {
      provider:
        parsed.provider === 'gemini' || parsed.provider === 'openai-compatible'
          ? parsed.provider
          : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
    };
  } catch {
    return { provider: '', model: '', endpoint: '' };
  }
}

export function saveFallbackPrefs(prefs: FallbackPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

/** Provider/endpoint/model triple written onto a new import batch. */
export function resolveImportFallback(): {
  fallbackProvider: OcrProvider | null;
  fallbackModel: string | null;
  fallbackEndpoint: string | null;
} {
  const prefs = loadFallbackPrefs();
  if (!prefs.provider) {
    return { fallbackProvider: null, fallbackModel: null, fallbackEndpoint: null };
  }
  const model = prefs.model.trim() || DEFAULT_FALLBACK_MODEL;
  const endpoint =
    prefs.provider === 'openai-compatible' && prefs.endpoint.trim() !== ''
      ? prefs.endpoint.trim()
      : null;
  return { fallbackProvider: prefs.provider, fallbackModel: model, fallbackEndpoint: endpoint };
}
