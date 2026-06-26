import { useEffect, useState } from 'react';

import { getUserRemixPrefs, setUserRemixPrefs } from '../import/api.js';
import {
  DEFAULT_REMIX_MODEL_BY_PROVIDER,
  DEFAULT_REMIX_PROMPT,
  type RemixProvider,
} from './remixSettings.js';

/**
 * Settings UI for Recipe Remix. The user picks a default model + system
 * prompt; the worker uses those when "Remix" transforms a recipe. The
 * per-remix request ("make it a sheet-pan dinner") is typed at remix time.
 * The actual API key is reused from the OCR Vault keys above this section.
 */
export function RemixSettingsSection() {
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState<RemixProvider>('gemini');
  const [model, setModel] = useState(DEFAULT_REMIX_MODEL_BY_PROVIDER.gemini);
  const [prompt, setPrompt] = useState(DEFAULT_REMIX_PROMPT);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void getUserRemixPrefs()
      .then((p) => {
        if (cancelled || !p) {
          setLoaded(true);
          return;
        }
        setProvider(p.provider);
        setModel(p.model || DEFAULT_REMIX_MODEL_BY_PROVIDER[p.provider]);
        setPrompt(p.prompt || DEFAULT_REMIX_PROMPT);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError((e as Error).message);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onProviderChange(next: RemixProvider) {
    setProvider(next);
    if (model === DEFAULT_REMIX_MODEL_BY_PROVIDER[provider] || !model) {
      setModel(DEFAULT_REMIX_MODEL_BY_PROVIDER[next]);
    }
    setSaved(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await setUserRemixPrefs({ provider, model: model.trim(), prompt });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-700 dark:bg-stone-900"
      data-testid="remix-settings"
    >
      <div>
        <h2 className="text-lg font-semibold">Recipe Remix</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          When you click <em>Remix</em> on a recipe, the worker uses these defaults to transform it
          per your request (e.g. "make it a sheet-pan dinner"). The API key is shared with the OCR
          import flow above.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <Field label="Provider">
        <select
          value={provider}
          onChange={(e) => onProviderChange(e.target.value as RemixProvider)}
          disabled={!loaded}
          className="w-full rounded border border-stone-300 px-3 py-2 dark:border-stone-600"
        >
          <option value="gemini">Google Gemini</option>
          <option value="openai-compatible">OpenAI-compatible</option>
        </select>
      </Field>

      <Field label="Remix model">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!loaded}
          className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-600"
          spellCheck={false}
          data-testid="remix-model"
        />
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          Text-only is enough; remix doesn't read images. Examples: <code>gemini-2.5-flash</code>,{' '}
          <code>gpt-4o-mini</code>.
        </p>
      </Field>

      <Field label="Remix system prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={!loaded}
          required
          rows={12}
          className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-xs dark:border-stone-600"
          spellCheck={false}
          data-testid="remix-prompt"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!loaded}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          Save remix settings
        </button>
        <button
          type="button"
          onClick={() => setPrompt(DEFAULT_REMIX_PROMPT)}
          className="rounded-md px-4 py-2 text-sm text-stone-600 hover:text-stone-900 dark:text-stone-300"
        >
          Reset prompt
        </button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">
        {label}
      </span>
      {children}
    </label>
  );
}
