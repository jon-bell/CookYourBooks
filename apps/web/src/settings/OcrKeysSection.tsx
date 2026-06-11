import { useEffect, useState } from 'react';

import {
  deleteOcrKey,
  listOcrKeys,
  type OcrKeySummary,
  type OcrProvider,
  setOcrKey,
} from '../import/api.js';

const PROVIDERS: OcrProvider[] = ['gemini', 'openai-compatible'];

const LABELS: Record<OcrProvider, string> = {
  gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible',
};

/**
 * Server-side OCR keys (BYOK). The keys live in Supabase Vault — only
 * the worker (running as the service role) can decrypt them; the
 * browser never reads the key back. Set / rotate per provider.
 */
export function OcrKeysSection() {
  const [keys, setKeys] = useState<OcrKeySummary[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<
    Record<OcrProvider, { key: string; baseUrl: string; busy: boolean }>
  >({
    gemini: { key: '', baseUrl: '', busy: false },
    'openai-compatible': { key: '', baseUrl: '', busy: false },
  });

  async function refresh() {
    try {
      setKeys(await listOcrKeys());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => void refresh(), []);

  async function save(provider: OcrProvider) {
    const entry = draft[provider];
    if (!entry.key.trim()) return;
    setDraft((cur) => ({ ...cur, [provider]: { ...cur[provider], busy: true } }));
    setError(null);
    try {
      await setOcrKey(
        provider,
        entry.key.trim(),
        provider === 'openai-compatible' ? entry.baseUrl.trim() || undefined : undefined,
      );
      setDraft((cur) => ({
        ...cur,
        [provider]: { key: '', baseUrl: '', busy: false },
      }));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setDraft((cur) => ({ ...cur, [provider]: { ...cur[provider], busy: false } }));
    }
  }

  async function remove(provider: OcrProvider) {
    if (!confirm(`Delete the ${LABELS[provider]} key from the server?`)) return;
    try {
      await deleteOcrKey(provider);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const keyByProvider = new Map<string, OcrKeySummary>((keys ?? []).map((k) => [k.provider, k]));

  return (
    <section className="space-y-4 rounded-lg border border-stone-200 bg-white p-5">
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
          , or use any OpenAI-compatible provider (OpenAI, Groq, Together, OpenRouter…).
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <ul className="space-y-4">
        {PROVIDERS.map((p) => {
          const current = keyByProvider.get(p);
          const entry = draft[p];
          return (
            <li key={p} className="space-y-2 rounded-md border border-stone-200 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{LABELS[p]}</div>
                  <div className="mt-0.5 text-xs text-stone-500">
                    {current ? (
                      <>
                        fingerprint <code className="font-mono">{current.key_fingerprint}</code>
                        {' · rotated '}
                        {new Date(current.rotated_at).toLocaleString()}
                      </>
                    ) : (
                      '(not set)'
                    )}
                  </div>
                </div>
                {current && (
                  <button
                    type="button"
                    onClick={() => void remove(p)}
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
                  value={entry.key}
                  onChange={(e) =>
                    setDraft((cur) => ({ ...cur, [p]: { ...cur[p], key: e.target.value } }))
                  }
                  placeholder={current ? 'Rotate: paste new key' : 'Paste API key'}
                  className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => void save(p)}
                  disabled={entry.busy || !entry.key.trim()}
                  className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
                >
                  {entry.busy ? 'Saving…' : 'Save'}
                </button>
              </div>
              {p === 'openai-compatible' && (
                <input
                  value={entry.baseUrl}
                  onChange={(e) =>
                    setDraft((cur) => ({ ...cur, [p]: { ...cur[p], baseUrl: e.target.value } }))
                  }
                  placeholder="Base URL (optional, defaults to https://api.openai.com/v1)"
                  className="w-full rounded border border-stone-300 px-3 py-2 text-xs"
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
