import { useEffect, useState } from 'react';

import {
  deleteOcrKey,
  listOcrKeys,
  type OcrKeySummary,
  type OcrProvider,
  setOcrKey,
} from '../import/api.js';

const LABELS: Record<OcrProvider, string> = {
  gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible',
};

/**
 * Server-side OCR keys (BYOK). The keys live in Supabase Vault — only
 * the worker (running as the service role) can decrypt them; the
 * browser never reads the key back.
 *
 * Gemini has one API surface, so it keeps a single key slot. The
 * OpenAI-compatible provider supports any number of named endpoints
 * (OpenAI, OpenRouter, Groq, self-hosted…), each with its own base URL +
 * key — saving to an existing endpoint name rotates that key in place.
 */
export function OcrKeysSection() {
  const [keys, setKeys] = useState<OcrKeySummary[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [geminiDraft, setGeminiDraft] = useState({ key: '', busy: false });
  const [oaiDraft, setOaiDraft] = useState({
    endpoint: 'default',
    baseUrl: '',
    key: '',
    busy: false,
  });

  async function refresh() {
    try {
      setKeys(await listOcrKeys());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => void refresh(), []);

  async function saveGemini() {
    if (!geminiDraft.key.trim()) return;
    setGeminiDraft((cur) => ({ ...cur, busy: true }));
    setError(null);
    try {
      await setOcrKey('gemini', geminiDraft.key.trim());
      setGeminiDraft({ key: '', busy: false });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setGeminiDraft((cur) => ({ ...cur, busy: false }));
    }
  }

  async function saveOai() {
    const endpoint = oaiDraft.endpoint.trim().toLowerCase() || 'default';
    if (!oaiDraft.key.trim()) return;
    setOaiDraft((cur) => ({ ...cur, busy: true }));
    setError(null);
    try {
      await setOcrKey(
        'openai-compatible',
        oaiDraft.key.trim(),
        oaiDraft.baseUrl.trim() || undefined,
        endpoint,
      );
      setOaiDraft({ endpoint: 'default', baseUrl: '', key: '', busy: false });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setOaiDraft((cur) => ({ ...cur, busy: false }));
    }
  }

  async function remove(provider: OcrProvider, endpoint: string) {
    const what =
      provider === 'gemini'
        ? LABELS.gemini
        : `${LABELS['openai-compatible']} “${endpoint}” endpoint`;
    if (!confirm(`Delete the ${what} key from the server?`)) return;
    try {
      await deleteOcrKey(provider, endpoint);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const gemini = (keys ?? []).find((k) => k.provider === 'gemini');
  const oaiKeys = (keys ?? []).filter((k) => k.provider === 'openai-compatible');

  return (
    <section className="space-y-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-5">
      <div>
        <h2 className="text-lg font-semibold">OCR keys</h2>
        <p className="mt-1 text-sm text-stone-600">
          API keys for the OCR worker. Stored in Supabase Vault — only the worker (running as the
          service role) can decrypt them. The browser never reads the key back. The same keys power
          the bulk import flow and the bakeoff page.
        </p>
        <p className="mt-1 text-sm text-stone-600">
          Need a key? Create a free Google Gemini key at{' '}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Google AI Studio
          </a>
          , or add any number of OpenAI-compatible endpoints (OpenAI, Groq, Together, OpenRouter…) —
          each endpoint keeps its own key and base URL, so a retry can hop providers.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <ul className="space-y-4">
        {/* Gemini: single key slot. */}
        <li className="space-y-2 rounded-md border border-stone-200 dark:border-stone-700 p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">{LABELS.gemini}</div>
              <div className="mt-0.5 text-xs text-stone-500">
                {gemini ? (
                  <>
                    fingerprint <code className="font-mono">{gemini.key_fingerprint}</code>
                    {' · rotated '}
                    {new Date(gemini.rotated_at).toLocaleString()}
                  </>
                ) : (
                  '(not set)'
                )}
              </div>
            </div>
            {gemini && (
              <button
                type="button"
                onClick={() => void remove('gemini', 'default')}
                className="rounded-md px-3 py-1.5 text-xs text-red-700 hover:bg-red-50"
              >
                Delete
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
            <input
              type="password"
              autoComplete="off"
              value={geminiDraft.key}
              onChange={(e) => setGeminiDraft((cur) => ({ ...cur, key: e.target.value }))}
              placeholder={gemini ? 'Rotate: paste new key' : 'Paste API key'}
              className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => void saveGemini()}
              disabled={geminiDraft.busy || !geminiDraft.key.trim()}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
            >
              {geminiDraft.busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </li>

        {/* OpenAI-compatible: a list of named endpoints. */}
        <li className="space-y-3 rounded-md border border-stone-200 dark:border-stone-700 p-3">
          <div className="text-sm font-medium">{LABELS['openai-compatible']}</div>
          {oaiKeys.length === 0 ? (
            <div className="text-xs text-stone-500">(no endpoints yet)</div>
          ) : (
            <ul className="space-y-1.5">
              {oaiKeys.map((k) => (
                <li
                  key={k.endpoint}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-stone-200 dark:border-stone-700 px-2.5 py-1.5 text-xs"
                >
                  <span className="min-w-0">
                    <span className="font-medium">{k.endpoint}</span>
                    <span className="text-stone-500">
                      {' · '}
                      <code className="font-mono">{k.key_fingerprint}</code>
                      {' · '}
                      {k.base_url || 'https://api.openai.com/v1'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove('openai-compatible', k.endpoint)}
                    className="rounded-md px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-2 border-t border-stone-200 dark:border-stone-700 pt-2">
            <div className="text-xs font-medium text-stone-600 dark:text-stone-400">
              Add / rotate an endpoint (re-using a name rotates its key)
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                value={oaiDraft.endpoint}
                onChange={(e) => setOaiDraft((cur) => ({ ...cur, endpoint: e.target.value }))}
                placeholder="Endpoint name (e.g. openrouter)"
                aria-label="Endpoint name"
                className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 text-xs"
              />
              <input
                value={oaiDraft.baseUrl}
                onChange={(e) => setOaiDraft((cur) => ({ ...cur, baseUrl: e.target.value }))}
                placeholder="Base URL (defaults to https://api.openai.com/v1)"
                aria-label="Base URL"
                className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 text-xs"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <input
                type="password"
                autoComplete="off"
                value={oaiDraft.key}
                onChange={(e) => setOaiDraft((cur) => ({ ...cur, key: e.target.value }))}
                placeholder="Paste API key"
                aria-label="API key"
                className="w-full rounded border border-stone-300 dark:border-stone-600 px-3 py-2 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => void saveOai()}
                disabled={oaiDraft.busy || !oaiDraft.key.trim()}
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
              >
                {oaiDraft.busy ? 'Saving…' : 'Save endpoint'}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>
  );
}
