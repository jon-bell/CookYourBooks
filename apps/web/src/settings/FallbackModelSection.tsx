import { useEffect, useState } from 'react';
import type { OcrProvider } from '../import/api.js';

const KEY = 'cookyourbooks.ocr.fallback.v1';

interface FallbackPrefs {
  provider: OcrProvider | '';
  model: string;
}

function load(): FallbackPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { provider: '', model: '' };
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

export function FallbackModelSection() {
  const [prefs, setPrefs] = useState<FallbackPrefs>(() => load());
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
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-5">
      <div>
        <h2 className="text-lg font-semibold">Fallback model</h2>
        <p className="mt-1 text-sm text-stone-600">
          When a batch hits copyright recitation on the default model and you opt in to
          retry, the worker uses this provider/model. Snapshotted onto each new batch on
          creation, so changes here only affect future batches.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700">Provider</span>
          <select
            value={prefs.provider}
            onChange={(e) =>
              setPrefs((p) => ({ ...p, provider: e.target.value as FallbackPrefs['provider'] }))
            }
            className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
          >
            <option value="">(none)</option>
            <option value="gemini">Google Gemini</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-stone-700">Model</span>
          <input
            value={prefs.model}
            onChange={(e) => setPrefs((p) => ({ ...p, model: e.target.value }))}
            className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm"
            disabled={!prefs.provider}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
        >
          Save fallback
        </button>
        {savedFlash && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </section>
  );
}
