import { useEffect, useState } from 'react';

import {
  addSavedOcrModel,
  deleteSavedOcrModel,
  formatSavedModel,
  listOcrKeys,
  listSavedOcrModels,
  type OcrKeySummary,
  type OcrProvider,
  type SavedOcrModel,
} from '../import/api.js';

/**
 * The user's saved "preferred models" list — provider + endpoint + model
 * triples that feed the retry picker on OCR failures (recitation /
 * content-filter refusals), so hopping to a different model or provider is
 * one dropdown away instead of a Settings round-trip.
 */
export function SavedModelsSection() {
  const [models, setModels] = useState<SavedOcrModel[] | undefined>();
  const [keys, setKeys] = useState<OcrKeySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    provider: OcrProvider;
    endpoint: string;
    model: string;
    busy: boolean;
  }>({ provider: 'gemini', endpoint: 'default', model: '', busy: false });

  async function refresh() {
    try {
      const [m, k] = await Promise.all([
        listSavedOcrModels(),
        listOcrKeys().catch(() => [] as OcrKeySummary[]),
      ]);
      setModels(m);
      setKeys(k);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => void refresh(), []);

  const oaiEndpoints = keys
    .filter((k) => k.provider === 'openai-compatible')
    .map((k) => k.endpoint);

  async function add() {
    if (!draft.model.trim()) return;
    setDraft((cur) => ({ ...cur, busy: true }));
    setError(null);
    try {
      await addSavedOcrModel({
        provider: draft.provider,
        endpoint: draft.provider === 'gemini' ? 'default' : draft.endpoint || 'default',
        model: draft.model,
      });
      setDraft((cur) => ({ ...cur, model: '', busy: false }));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setDraft((cur) => ({ ...cur, busy: false }));
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deleteSavedOcrModel(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-5">
      <div>
        <h2 className="text-lg font-semibold">Saved models</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Models you like retrying with. When a page fails on a copyright/content-filter refusal,
          the retry picker offers this list, so you can hop straight to a different model — or a
          different provider endpoint — without editing Settings.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {models !== undefined && models.length > 0 && (
        <ul className="space-y-1.5">
          {models.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-stone-200 dark:border-stone-700 px-2.5 py-1.5 text-xs"
            >
              <span>
                <span className="font-medium">{formatSavedModel(m)}</span>
                <span className="text-stone-500"> · {m.provider}</span>
              </span>
              <button
                type="button"
                onClick={() => void remove(m.id)}
                className="rounded-md px-2 py-1 text-xs text-red-700 hover:bg-red-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_auto_1fr_auto]">
        <select
          value={draft.provider}
          onChange={(e) => setDraft((cur) => ({ ...cur, provider: e.target.value as OcrProvider }))}
          aria-label="Provider"
          className="rounded border border-stone-300 dark:border-stone-600 px-2 py-2 text-sm"
        >
          <option value="gemini">Gemini</option>
          <option value="openai-compatible">OpenAI-compatible</option>
        </select>
        {draft.provider === 'openai-compatible' && (
          <select
            value={draft.endpoint}
            onChange={(e) => setDraft((cur) => ({ ...cur, endpoint: e.target.value }))}
            aria-label="Endpoint"
            className="rounded border border-stone-300 dark:border-stone-600 px-2 py-2 text-sm"
          >
            {(oaiEndpoints.length > 0 ? oaiEndpoints : ['default']).map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        )}
        <input
          value={draft.model}
          onChange={(e) => setDraft((cur) => ({ ...cur, model: e.target.value }))}
          placeholder="Model id (e.g. gemini-3.5-flash, gpt-5.4)"
          aria-label="Model id"
          className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={draft.busy || !draft.model.trim()}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          {draft.busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </section>
  );
}
