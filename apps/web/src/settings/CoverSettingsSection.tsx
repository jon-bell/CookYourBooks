import { useEffect, useState } from 'react';
import {
  DEFAULT_COVER_MODEL,
  DEFAULT_COVER_PROMPT,
  getUserCoverPrefs,
  setUserCoverPrefs,
} from '../recipe/coverApi.js';
import { GenerateCoversButton } from '../components/GenerateCoversButton.js';

/**
 * Settings UI for Gemini recipe-cover generation. The user picks the image
 * model + prompt template (RECIPE NAME / <INGREDIENTS> / <INSTRUCTIONS> tokens
 * are substituted per recipe by the worker) and can kick off a whole-library
 * generation. The API key is reused from the OCR Vault keys above.
 */
export function CoverSettingsSection() {
  const [loaded, setLoaded] = useState(false);
  const [model, setModel] = useState(DEFAULT_COVER_MODEL);
  const [prompt, setPrompt] = useState(DEFAULT_COVER_PROMPT);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void getUserCoverPrefs()
      .then((p) => {
        if (cancelled || !p) {
          setLoaded(true);
          return;
        }
        setModel(p.model || DEFAULT_COVER_MODEL);
        setPrompt(p.prompt || DEFAULT_COVER_PROMPT);
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await setUserCoverPrefs({ model: model.trim(), prompt });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-stone-200 bg-white p-5 dark:border-stone-700 dark:bg-stone-900"
      data-testid="cover-settings"
    >
      <div>
        <h2 className="text-lg font-semibold">Recipe covers</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Generate a cover image for any recipe with Gemini. Use{' '}
          <em>Generate with AI</em> on a recipe, <em>Generate covers</em> on a collection, or the
          whole-library button below. The API key is shared with the OCR import flow above.
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

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">
          Image model
        </span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!loaded}
          className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-600"
          spellCheck={false}
          data-testid="cover-model"
        />
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          Must be an image-output Gemini model. Default: <code>{DEFAULT_COVER_MODEL}</code>.
        </p>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-300">
          Cover prompt
        </span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={!loaded}
          required
          rows={5}
          className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-xs dark:border-stone-600"
          spellCheck={false}
          data-testid="cover-prompt"
        />
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          Tokens <code>RECIPE NAME</code>, <code>&lt;INGREDIENTS&gt;</code>, and{' '}
          <code>&lt;INSTRUCTIONS&gt;</code> are filled in per recipe.
        </p>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!loaded}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          Save cover settings
        </button>
        <button
          type="button"
          onClick={() => setPrompt(DEFAULT_COVER_PROMPT)}
          className="rounded-md px-4 py-2 text-sm text-stone-600 hover:text-stone-900 dark:text-stone-300"
        >
          Reset prompt
        </button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>

      <div className="border-t border-stone-200 pt-4 dark:border-stone-700">
        <p className="mb-2 text-sm text-stone-600 dark:text-stone-400">
          Generate covers for every imported recipe in your library that doesn't have one
          queued (not-yet-imported placeholders are skipped):
        </p>
        <GenerateCoversButton scope="library" label="Generate covers for my whole library" />
      </div>
    </form>
  );
}
