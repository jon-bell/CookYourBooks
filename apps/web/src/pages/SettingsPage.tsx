import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROMPT,
  clearOcrSettings,
  loadOcrSettings,
  saveOcrSettings,
  type OcrProvider,
  type OcrSettings,
} from '../settings/ocrSettings.js';
import { CliTokensSection } from '../settings/CliTokensSection.js';

/**
 * Per-device settings page. The API key lives in localStorage only — it
 * never syncs through Supabase, so losing the device (or signing out) drops
 * it. That's a deliberate choice to avoid a long-lived secret bouncing
 * around the server.
 */
export function SettingsPage() {
  const existing = loadOcrSettings();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<OcrProvider>(existing?.provider ?? 'gemini');
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? '');
  const [model, setModel] = useState(existing?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider]);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [prompt, setPrompt] = useState(existing?.prompt ?? DEFAULT_PROMPT);
  const [saved, setSaved] = useState(false);

  function onProviderChange(next: OcrProvider) {
    setProvider(next);
    // Only overwrite the model if the user is accepting the default for the
    // previous provider — stops us from clobbering their custom entry.
    if (model === DEFAULT_MODEL_BY_PROVIDER[provider] || !model) {
      setModel(DEFAULT_MODEL_BY_PROVIDER[next]);
    }
    setSaved(false);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: OcrSettings = {
      provider,
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseUrl: provider === 'openai-compatible' ? baseUrl.trim() || undefined : undefined,
      prompt,
    };
    saveOcrSettings(next);
    setSaved(true);
  }

  function onClear() {
    clearOcrSettings();
    setApiKey('');
    setBaseUrl('');
    setSaved(false);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-stone-600">
          Configure the large language model used for the "Import from photo" feature. Keys are
          stored locally on this device and never sent through Supabase.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Provider">
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as OcrProvider)}
            className="w-full rounded border border-stone-300 px-3 py-2"
          >
            <option value="gemini">Google Gemini (direct)</option>
            <option value="openai-compatible">OpenAI-compatible (OpenAI, Groq, OpenRouter, …)</option>
          </select>
        </Field>

        {provider === 'openai-compatible' && (
          <Field label="API base URL">
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded border border-stone-300 px-3 py-2"
            />
            <p className="mt-1 text-xs text-stone-500">
              Defaults to <code>https://api.openai.com/v1</code>. Point at Groq / Together /
              OpenRouter / your own proxy as needed.
            </p>
          </Field>
        )}

        <Field label="Model">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-stone-500">
            Must be multimodal (vision-capable). Examples: <code>gemini-2.0-flash-exp</code>,{' '}
            <code>gpt-4o</code>, <code>gpt-4o-mini</code>, <code>llama-3.2-90b-vision-preview</code>.
          </p>
        </Field>

        <Field label="API key">
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
            className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm"
            spellCheck={false}
          />
        </Field>

        <Field label="Prompt">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            rows={12}
            className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-xs"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-stone-500">
            The model is instructed to return JSON matching the app's domain shape. You can tune
            this prompt freely.
          </p>
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
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
            onClick={onClear}
            className="rounded-md px-4 py-2 text-sm text-red-700 hover:bg-red-50"
          >
            Clear all
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
