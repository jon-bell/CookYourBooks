import { useEffect, useState } from 'react';
import type { OcrProvider } from '../import/api.js';

const KEY = 'cookyourbooks.ocr.fallback.v1';

/** Snapshotted onto new import batches when the user hasn't saved fallback prefs. */
export const DEFAULT_FALLBACK_PROVIDER: OcrProvider = 'openai-compatible';
export const DEFAULT_FALLBACK_MODEL = 'gpt-5.4';

interface FallbackPrefs {
  provider: OcrProvider | '';
  model: string;
}

function load(): FallbackPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return { provider: DEFAULT_FALLBACK_PROVIDER, model: DEFAULT_FALLBACK_MODEL };
    }
    const parsed = JSON.parse(raw) as Partial<FallbackPrefs>;
    return {
      provider: parsed.provider === 'gemini' || parsed.provider === 'openai-compatible' ? parsed.provider : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
    };
  } catch {
    return { provider: '', model: '' };
  }
}

function save(prefs: FallbackPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

export function loadFallbackPrefs(): FallbackPrefs {
  return load();
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

export function FallbackModelSection() {
  const [prefs, setPrefs] = useState<FallbackPrefs>(() => loadFallbackPrefs());
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (!savedFlash) return;
    const t = window.setTimeout(() => setSavedFlash(false), 1500);
    return () => window.clearTimeout(t);
  }, [savedFlash]);

  function onSave() {
    save(prefs);
    setSavedFlash(true);
  }

  return (
    <section className="space-y-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-5">
      <div>
        <h2 className="text-lg font-semibold">Fallback model</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          When a batch hits copyright recitation on the default model and you opt in to
          retry, the worker uses this provider/model. Snapshotted onto each new batch on
          creation, so changes here only affect future batches.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">Provider</span>
          <select
            value={prefs.provider}
            onChange={(e) =>
              setPrefs((p) => ({ ...p, provider: e.target.value as FallbackPrefs['provider'] }))
            }
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 text-sm"
          >
            <option value="">(none)</option>
            <option value="gemini">Google Gemini</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">Model</span>
          <input
            value={prefs.model}
            onChange={(e) => setPrefs((p) => ({ ...p, model: e.target.value }))}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 font-mono text-sm"
            disabled={!prefs.provider}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          className="rounded-md bg-stone-900 dark:bg-stone-100 px-4 py-2 text-sm font-medium text-white dark:text-stone-900 hover:bg-stone-800 dark:hover:bg-stone-200"
        >
          Save fallback
        </button>
        {savedFlash && <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved.</span>}
      </div>
    </section>
  );
}
