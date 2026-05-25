import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROMPT,
  type OcrProvider,
} from '../settings/ocrSettings.js';
import { CliTokensSection } from '../settings/CliTokensSection.js';
import { OcrKeysSection } from '../settings/OcrKeysSection.js';
import { FallbackModelSection } from '../settings/FallbackModelSection.js';
import { ConversionsSection } from '../settings/ConversionsSection.js';
import { getUserOcrPrefs, setUserOcrPrefs } from '../import/api.js';

/**
 * Settings page. OCR API keys live server-side in Vault (handled by
 * {@link OcrKeysSection}); the model/prompt the import worker uses by
 * default live server-side in `user_ocr_prefs`. The bakeoff page can
 * "promote" a winning variant into these prefs in one click.
 */
export function SettingsPage() {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState<OcrProvider>('gemini');
  const [model, setModel] = useState(DEFAULT_MODEL_BY_PROVIDER.gemini);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void getUserOcrPrefs()
      .then((p) => {
        if (cancelled || !p) {
          setLoaded(true);
          return;
        }
        setProvider(p.provider);
        setModel(p.model || DEFAULT_MODEL_BY_PROVIDER[p.provider]);
        setPrompt(p.prompt || DEFAULT_PROMPT);
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) {
          setError((e as Error).message);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onProviderChange(next: OcrProvider) {
    setProvider(next);
    if (model === DEFAULT_MODEL_BY_PROVIDER[provider] || !model) {
      setModel(DEFAULT_MODEL_BY_PROVIDER[next]);
    }
    setSaved(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await setUserOcrPrefs({
        provider,
        model: model.trim(),
        prompt,
      });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          OCR provider keys, default model, and prompt the bulk import flow uses. All values are
          stored server-side; the keys live in Supabase Vault and never leave the worker.
        </p>
      </div>

      <OcrKeysSection />
      <FallbackModelSection />
      <ConversionsSection />

      {error && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-stone-200 bg-white p-5">
        <div>
          <h2 className="text-lg font-semibold">Default model + prompt</h2>
          <p className="mt-1 text-sm text-stone-600">
            Used as the starting values on the New import page. You can override per-batch when
            you start an import, or use the{' '}
            <a href="/import/new/bakeoff" className="underline">
              Bakeoff
            </a>{' '}
            to compare configurations and promote a winner in one click.
          </p>
        </div>

        <Field label="Provider">
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as OcrProvider)}
            disabled={!loaded}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2"
          >
            <option value="gemini">Google Gemini</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </Field>

        <Field label="Default model">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={!loaded}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 font-mono text-sm"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Must be multimodal (vision-capable). Examples: <code>gemini-3-pro-image-preview</code>,{' '}
            <code>gpt-4o</code>, <code>gpt-4o-mini</code>.
          </p>
        </Field>

        <Field label="Default prompt">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!loaded}
            required
            rows={12}
            className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 font-mono text-xs"
            spellCheck={false}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!loaded}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
          >
            Save settings
          </button>
          <button
            type="button"
            onClick={() => setPrompt(DEFAULT_PROMPT)}
            className="rounded-md px-4 py-2 text-sm text-stone-600 hover:text-stone-900"
          >
            Reset prompt
          </button>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="rounded-md px-4 py-2 text-sm text-stone-600 hover:text-stone-900"
          >
            Back
          </button>
          {saved && <span className="text-sm text-emerald-700">Saved.</span>}
        </div>
      </form>

      <CliTokensSection />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
    </label>
  );
}
