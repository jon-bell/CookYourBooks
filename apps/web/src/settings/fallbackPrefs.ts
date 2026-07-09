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
}

export function loadFallbackPrefs(): FallbackPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return { provider: DEFAULT_FALLBACK_PROVIDER, model: DEFAULT_FALLBACK_MODEL };
    }
    const parsed = JSON.parse(raw) as Partial<FallbackPrefs>;
    return {
      provider:
        parsed.provider === 'gemini' || parsed.provider === 'openai-compatible'
          ? parsed.provider
          : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
    };
  } catch {
    return { provider: '', model: '' };
  }
}

export function saveFallbackPrefs(prefs: FallbackPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

/** Provider/model pair written onto a new import batch. */
export function resolveImportFallback(): {
  fallbackProvider: OcrProvider | null;
  fallbackModel: string | null;
} {
  const prefs = loadFallbackPrefs();
  if (!prefs.provider) {
    return { fallbackProvider: null, fallbackModel: null };
  }
  const model = prefs.model.trim() || DEFAULT_FALLBACK_MODEL;
  return { fallbackProvider: prefs.provider, fallbackModel: model };
}
