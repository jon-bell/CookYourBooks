import { useEffect, useState } from 'react';
import {
  deleteOcrKey,
  listOcrKeys,
  setOcrKey,
  type OcrKeySummary,
  type OcrProvider,
} from '../import/api.js';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  loadOcrSettings,
  saveOcrSettings,
  clearOcrSettings,
} from './ocrSettings.js';

const PROVIDERS: OcrProvider[] = ['gemini', 'openai-compatible'];

const LABELS: Record<OcrProvider, string> = {
  gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible',
};

/**
 * Server-side OCR keys (BYOK). Replaces the local-storage key the
 * legacy `OcrSettings` form holds. Also handles the one-time migration
 * prompt that moves an existing browser-side key into Vault.
 */
export function OcrKeysSection() {
  const [keys, setKeys] = useState<OcrKeySummary[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [legacyDismissed, setLegacyDismissed] = useState(false);
  const [draft, setDraft] = useState<Record<OcrProvider, { key: string; baseUrl: string; busy: boolean }>>({
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

  const legacy = loadOcrSettings();
  const showLegacyMigration =
    !!legacy?.apiKey && !legacyDismissed && (keys?.length ?? 0) === 0;

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

  async function migrateLegacy() {
    if (!legacy?.apiKey) return;
    setMigrating(true);
    setError(null);
    try {
      await setOcrKey(legacy.provider, legacy.apiKey, legacy.baseUrl);
      // Persist remaining settings (model / prompt / baseUrl) without the key.
      saveOcrSettings({
        provider: legacy.provider,
        apiKey: '',
        model: legacy.model || DEFAULT_MODEL_BY_PROVIDER[legacy.provider],
        baseUrl: legacy.baseUrl,
        prompt: legacy.prompt,
      });
      await refresh();
      setLegacyDismissed(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMigrating(false);
    }
  }

  const keyByProvider = new Map<string, OcrKeySummary>(
    (keys ?? []).map((k) => [k.provider, k]),
  );

  return (
    <section className="space-y-4 rounded-lg border border-stone-200 bg-white p-5">
      <div>
        <h2 className="text-lg font-semibold">OCR keys (server-side)</h2>
        <p className="mt-1 text-sm text-stone-600">
          API keys for the bulk OCR worker. Stored in Supabase Vault — only the worker
          (running as the service role) can decrypt them. The browser never reads the key
          back. Set / rotate per provider.
        </p>
      </div>

      {showLegacyMigration && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-medium">Move your legacy in-browser key to the server?</div>
          <div className="text-xs">
            You have a key stored locally for {LABELS[legacy!.provider]}. The new bulk
            import flow runs OCR server-side and needs the key in Vault. After moving, the
            local copy is cleared.
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void migrateLegacy()}
              disabled={migrating}
              className="rounded-md bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-60"
            >
              {migrating ? 'Moving…' : 'Move to server'}
            </button>
            <button
              type="button"
              onClick={() => setLegacyDismissed(true)}
              className="rounded-md px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

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

      {legacy?.apiKey && (
        <div className="flex items-center justify-between text-xs text-stone-500">
          <span>
            Legacy in-browser key is still present. Once you've confirmed the server key
            works, you can clear it.
          </span>
          <button
            type="button"
            onClick={() => {
              clearOcrSettings();
              setLegacyDismissed(true);
            }}
            className="rounded-md px-2 py-1 text-stone-700 hover:bg-stone-100"
          >
            Clear local key
          </button>
        </div>
      )}
    </section>
  );
}
